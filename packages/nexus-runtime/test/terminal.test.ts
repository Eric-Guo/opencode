import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Pty } from "@opencode/core/pty"
import { AbsolutePath } from "@opencode/schema/schema"
import { APIError, type TaskRealtime } from "@cybros/agent"
import { tmpdir } from "node:os"
import { location } from "../../core/test/fixture/location"
import { testEffect } from "../../core/test/lib/effect"
import { terminalTools } from "../src/extensions"
import { RealtimePeer } from "../src/realtime"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, Bus.node]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmpdir()) }))),
    ),
  ]),
)
const terminalTest = process.platform === "win32" ? it.live.skip : it.live

// Real PTY and ICE/DTLS/SCTP prove the handler's ownership and byte-stream wiring together.
terminalTest(
  "a claim terminal starts after viewer resume and releases its real PTY on cancellation",
  () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service

      yield* Effect.promise(async () => {
        const owner = new AbortController()
        const offered = Promise.withResolvers<string>()
        const viewer = await RealtimePeer.create()
        const state: { value: TaskRealtime } = {
          value: {
            status: "active",
            reason: null,
            connection_id: null,
            offer_sdp: null,
            ice_servers: null,
            answer_sdp: null,
            max_age_ms: 1000,
          },
        }
        const work = terminalTools(tmpdir(), owner.signal, { pty: async () => pty })[0]!.execute(
          {},
          {
            workspace: "workspace",
            conversation: null,
            run: "run",
            task: "terminal",
            directory: tmpdir(),
            signal: owner.signal,
            realtime: {
              read: async () => state.value,
              offer: async (input) => {
                expect(input.connection_id).toMatch(
                  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                )
                state.value = { ...state.value, connection_id: input.connection_id, offer_sdp: input.sdp }
                offered.resolve(input.sdp)
                return state.value
              },
            },
          },
        )

        void work.catch(() => {})

        try {
          expect(await Effect.runPromise(pty.list())).toEqual([])
          const answer = await viewer.answer(await offered.promise)

          state.value = { ...state.value, answer_sdp: answer }

          const deadline = AbortSignal.timeout(10000)

          while (!viewer.poll(1000).ready) {
            deadline.throwIfAborted()
            await Bun.sleep(5)
          }

          viewer.send(JSON.stringify({ type: "resume", offset: 0 }))

          while (!(await Effect.runPromise(pty.list())).length) {
            deadline.throwIfAborted()
            await Bun.sleep(5)
          }

          viewer.send(
            JSON.stringify({
              type: "input",
              id: 1,
              data: Buffer.from("printf 'NEXUS_%s_OK\\n' TERMINAL\n").toString("base64"),
            }),
          )

          let output = ""
          let cursor = 0

          while (!output.includes("NEXUS_TERMINAL_OK")) {
            deadline.throwIfAborted()
            viewer.send(JSON.stringify({ type: "resume", offset: cursor }))

            for (const bytes of viewer.poll(1000).data) {
              const frame = JSON.parse(bytes.toString()) as { type: string; offset: number; data: string; to: number }

              if (frame.type === "gap") cursor = frame.to
              if (frame.type === "output") {
                const data = Buffer.from(frame.data, "base64")

                output += data.toString()
                cursor = frame.offset + data.length
              }
            }

            await Bun.sleep(10)
          }

          expect(output).toContain("NEXUS_TERMINAL_OK")
          owner.abort()
          await expect(work).rejects.toThrow()
          expect(await Effect.runPromise(pty.list())).toEqual([])
        } finally {
          owner.abort()
          await work.catch(() => {})
          await viewer.close()
        }
      })
    }),
  15000,
)

// A real STUN binding responder proves the inherited deployment server is actually used for gathering.
async function stunResponder() {
  const server = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, message, port, address) {
        if (message.length < 20 || message.readUInt16BE(0) !== 0x0001 || message.readUInt32BE(4) !== 0x2112a442)
          return

        const response = Buffer.alloc(32)

        response.writeUInt16BE(0x0101, 0)
        response.writeUInt16BE(12, 2)
        message.copy(response, 4, 4, 20)
        response.writeUInt16BE(0x0020, 20)
        response.writeUInt16BE(8, 22)
        response.writeUInt8(1, 25)
        response.writeUInt16BE(port ^ 0x2112, 26)
        response.writeUInt32BE((ipv4(address) ^ 0x2112a442) >>> 0, 28)
        socket.send(response, port, address)
      },
    },
  })

  return server
}

function ipv4(address: string) {
  return address.split(".").reduce((acc, part) => (acc << 8) | Number(part), 0)
}

terminalTest(
  "a terminal without configured ICE servers inherits the handshake servers and retries through the relay",
  () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service

      yield* Effect.promise(async () => {
        const owner = new AbortController()
        const stun = await stunResponder()
        const offers: string[] = []
        const state: { value: TaskRealtime } = {
          value: {
            status: "active",
            reason: null,
            connection_id: null,
            offer_sdp: null,
            ice_servers: [{ urls: ["stun:127.0.0.1:" + stun.port] }],
            answer_sdp: null,
            max_age_ms: 1000,
          },
        }
        const work = terminalTools(tmpdir(), owner.signal, { pty: async () => pty })[0]!.execute(
          {},
          {
            workspace: "workspace",
            conversation: null,
            run: "run",
            task: "terminal",
            directory: tmpdir(),
            signal: owner.signal,
            realtime: {
              read: async () => state.value,
              offer: async (input) => {
                offers.push(input.sdp)
                if (offers.length === 1) throw new APIError("Unavailable", 503, "unavailable", null, null, null)

                state.value = { ...state.value, connection_id: input.connection_id, offer_sdp: input.sdp }
                return state.value
              },
            },
          },
        )

        void work.catch(() => {})

        try {
          const deadline = AbortSignal.timeout(10000)

          while (offers.length < 2) {
            deadline.throwIfAborted()
            await Bun.sleep(5)
          }

          expect(offers[0]).toContain("typ srflx")
          expect(offers[1]).not.toContain("typ host")
        } finally {
          owner.abort()
          await work.catch(() => {})
          stun.close()
        }
      })
    }),
  15000,
)

terminalTest(
  "a refused handshake ICE servers read closes the terminal signaling before any offer",
  () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service

      yield* Effect.promise(async () => {
        const owner = new AbortController()
        let reads = 0
        const offers: string[] = []
        const work = terminalTools(tmpdir(), owner.signal, { pty: async () => pty })[0]!.execute(
          {},
          {
            workspace: "workspace",
            conversation: null,
            run: "run",
            task: "terminal",
            directory: tmpdir(),
            signal: owner.signal,
            realtime: {
              read: async () => {
                reads++
                throw new APIError("Not found", 404, "not_found", null, null, null)
              },
              offer: async (input) => {
                offers.push(input.sdp)
                throw new Error("The closed handshake must not receive an offer.")
              },
            },
          },
        )

        void work.catch(() => {})

        try {
          const deadline = AbortSignal.timeout(5000)

          while (!reads) {
            deadline.throwIfAborted()
            await Bun.sleep(5)
          }

          await Bun.sleep(300)
          expect(reads).toBe(1)
          expect(offers).toEqual([])
        } finally {
          owner.abort()
          await expect(work).rejects.toThrow()
        }
      })
    }),
  10000,
)
