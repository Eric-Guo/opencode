import { Effect, Schema } from "effect"
import { setTimeout } from "node:timers/promises"
import { APIError, TransportError } from "@cybros/agent"
import type { HostTools } from "./host"
import type { RunnerContext } from "./extensions"
import { OutputWindow, RealtimeLease, RealtimePeer, type RealtimeOptions } from "./realtime"

const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Frame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("resume"), offset: Offset }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 500 })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 200 })),
  }),
  Schema.Struct({ type: Schema.Literal("input"), id: Offset, data: Schema.String }),
])

/** The claim owns its PTY. Replacing a peer preserves the shell and only resumes authorized output. */
export async function terminalSession(
  host: Pick<HostTools, "pty">,
  context: RunnerContext,
  options: RealtimeOptions = {},
) {
  const realtime = context.realtime

  if (!realtime) throw new Error("Terminal requires a claim realtime context.")

  const pty = await host.pty(context.directory)
  const window = new OutputWindow()
  const shell: { id?: Parameters<typeof pty.remove>[0]; ended: boolean; size: { cols: number; rows: number } } = {
    ended: false,
    size: { cols: 80, rows: 24 },
  }
  const permission = new RealtimeLease()
  const controller = new AbortController()
  const signal = AbortSignal.any([context.signal, controller.signal])
  const allowed = () => permission.allowed
  const refresh = (async () => {
    while (!signal.aborted) {
      const generation = permission.generation
      const started = performance.now()
      if (generation && permission.snapshot && !permission.closed) {
        const value = await realtime.read().catch((error: unknown) => {
          permission.unavailable(error)
          return undefined
        })
        if (value) permission.accept(generation, value, started)
      }
      await setTimeout(250, undefined, { signal })
    }
  })().catch(() => {})
  let peer: RealtimePeer | undefined
  let previous: string | undefined
  let sequence = 0
  let failures = 0
  let relay = options.relay ?? false
  let retryAfter = 0

  try {
    while (!signal.aborted && !shell.ended) {
      if (permission.closed) {
        window.clear()
        await setTimeout(250, undefined, { signal })
        continue
      }
      if (failures) await setTimeout(Math.max(retryAfter, 1000 * 2 ** Math.min(failures - 1, 3)), undefined, { signal })
      retryAfter = 0
      const id = crypto.randomUUID()
      try {
        peer = await RealtimePeer.create({ ...options, relay })
        const sdp = await peer.offer()
        const started = performance.now()
        const current = await realtime.read()
        if (current.status === "closed") {
          permission.begin(id)
          permission.accept(id, current, started)
          await peer.close()
          peer = undefined
          continue
        }
        permission.begin(id)
        const offered = await realtime
          .offer({ connection_id: id, sdp, previous_connection_id: previous ?? current.connection_id ?? undefined })
          .catch(async (error: unknown) => {
            const receipt = await realtime.read()
            if (receipt.connection_id === id) return receipt
            throw error
          })
        permission.accept(id, offered, started)
        previous = id
      } catch (error) {
        signal.throwIfAborted()
        permission.unavailable(error)
        await peer?.close()
        peer = undefined
        if (permission.closed) continue
        if (!(error instanceof APIError || error instanceof TransportError)) throw error
        retryAfter =
          error instanceof APIError
            ? Math.max(0, Number(error.retryAfter) * 1000 || Date.parse(error.retryAfter ?? "") - Date.now() || 0)
            : 0
        failures = Math.min(failures + 1, 4)
        relay ||= Boolean(options.servers?.length)
        continue
      }
      let resumed = false
      let cursor: number | undefined
      let inputID = 0
      let connected = false
      let deadline = performance.now() + 10000

      while (!signal.aborted && !shell.ended) {
        const snapshot = permission.snapshot

        if (snapshot?.connection_id === id && snapshot.answer_sdp && !connected) {
          await peer.remote(snapshot.answer_sdp)
          connected = true
          deadline = performance.now() + 10000
        }

        if (permission.closed) break
        const packet = peer.poll(permission.remaining, permission.since)
        if (packet.ready) failures = 0

        if (
          ["failed", "disconnected", "closed"].includes(packet.state) ||
          (!packet.ready && performance.now() > deadline)
        )
          break

        for (const bytes of packet.data) {
          const frame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))(bytes.toString("utf8"))

          if (frame.type === "resume") {
            window.frame(frame.offset)
            cursor = frame.offset
            resumed = true
            continue
          }

          if (!resumed) throw new Error("Terminal input arrived before resume.")
          if (!allowed()) continue
          if (frame.type === "resize") {
            shell.size = { cols: frame.cols, rows: frame.rows }
            if (shell.id)
              await Effect.runPromise(pty.update(shell.id, { size: { cols: frame.cols, rows: frame.rows } }), {
                signal,
              })
            continue
          }

          if (
            !shell.id ||
            frame.id <= inputID ||
            frame.id === 0 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
          )
            throw new Error("Invalid or out-of-order terminal input.")

          const data = Buffer.from(frame.data, "base64")

          if (data.length < 1 || data.length > 8192) throw new Error("Terminal input must contain 1..8 KiB.")

          inputID = frame.id
          if (sequence === Number.MAX_SAFE_INTEGER) throw new Error("Terminal input sequence overflow.")
          sequence++
          peer.send(JSON.stringify({ type: "receipt", id: inputID, sequence, status: "received", bytes: data.length }))
          await Effect.runPromise(pty.write(shell.id, data.toString("utf8")), { signal })

          if (allowed())
            peer.send(JSON.stringify({ type: "receipt", id: inputID, sequence, status: "written", bytes: data.length }))
        }

        if (packet.ready && resumed && allowed() && !shell.id) {
          const info = await Effect.runPromise(pty.create({ cwd: context.directory, title: "Nexus" }), { signal })

          shell.id = info.id
          await Effect.runPromise(pty.update(info.id, { size: shell.size }), { signal })

          const attachment = await Effect.runPromise(
            pty.attach(info.id, {
              onData: (data) => window.append(Buffer.from(data), allowed()),
              onEnd: () => {
                shell.ended = true
              },
            }),
            { signal },
          )

          window.append(Buffer.from(attachment.replay), allowed())
          attachment.activate()
        }

        if (packet.ready && cursor !== undefined && allowed()) {
          const frame = window.frame(cursor)

          if (frame && peer.send(JSON.stringify(frame))) cursor = undefined
        }

        await setTimeout(10, undefined, { signal })
      }

      await peer.close()
      peer = undefined
      failures = Math.min(failures + 1, 4)
      relay ||= Boolean(options.servers?.length)
    }

    context.signal.throwIfAborted()

    return { content: "Terminal exited." }
  } finally {
    controller.abort()
    await refresh
    await peer?.close()
    if (shell.id) await Effect.runPromise(pty.remove(shell.id)).catch(() => {})
    window.clear()
  }
}
