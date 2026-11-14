import { Effect, Schema } from "effect"
import { setTimeout as delay } from "node:timers/promises"
import type { TaskRealtime } from "@cybros/agent"
import type { HostTools } from "./host"
import type { RunnerContext } from "./extensions"
import { OutputWindow, RealtimePeer, type RealtimeOptions } from "./realtime"

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
  const shell: { id?: Parameters<typeof pty.remove>[0]; ended: boolean } = { ended: false }
  const permission: { value?: TaskRealtime; until: number; since: number } = { until: 0, since: 0 }
  const controller = new AbortController()
  const signal = AbortSignal.any([context.signal, controller.signal])
  const allowed = () => performance.now() < permission.until
  const refresh = (async () => {
    while (!signal.aborted) {
      const started = performance.now()
      const value = await realtime.read().catch(() => undefined)

      if (value) {
        if (!allowed()) permission.since = performance.now()
        permission.value = value
        permission.until = value.status === "active" ? started + Math.min(1000, value.max_age_ms) : 0
      }

      await delay(250, undefined, { signal })
    }
  })().catch(() => {})
  let peer: RealtimePeer | undefined
  let previous: string | undefined
  let sequence = 0

  try {
    while (!signal.aborted && !shell.ended) {
      peer = await RealtimePeer.create(options)

      const id = crypto.randomUUID()
      const sdp = await peer.offer()
      const current = await realtime.read()
      const offered = await realtime
        .offer({ connection_id: id, sdp, previous_connection_id: previous ?? current.connection_id ?? undefined })
        .catch(async (error: unknown) => {
          const receipt = await realtime.read()

          if (receipt.connection_id === id) return receipt
          throw error
        })

      permission.value = offered
      previous = id
      let resumed = false
      let cursor: number | undefined
      let inputID = 0
      let connected = false
      const deadline = performance.now() + 10000

      while (!signal.aborted && !shell.ended) {
        const snapshot = permission.value

        if (snapshot?.connection_id === id && snapshot.answer_sdp && !connected) {
          await peer.remote(snapshot.answer_sdp)
          connected = true
        }

        const packet = peer.poll(allowed() ? Math.max(0, permission.until - performance.now()) : 0, permission.since)

        if (
          ["failed", "disconnected", "closed"].includes(packet.state) ||
          (!packet.ready && performance.now() > deadline)
        )
          break
        if (snapshot?.connection_id === id && snapshot.status === "closed") return { content: "Terminal closed." }

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
          sequence++
          peer.send(JSON.stringify({ type: "receipt", id: inputID, sequence, status: "received", bytes: data.length }))
          await Effect.runPromise(pty.write(shell.id, data.toString("utf8")), { signal })

          if (allowed())
            peer.send(JSON.stringify({ type: "receipt", id: inputID, sequence, status: "written", bytes: data.length }))
        }

        if (packet.ready && resumed && allowed() && !shell.id) {
          const info = await Effect.runPromise(pty.create({ cwd: context.directory, title: "Nexus" }), { signal })

          shell.id = info.id

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

        await delay(10, undefined, { signal })
      }

      await peer.close()
      peer = undefined
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
