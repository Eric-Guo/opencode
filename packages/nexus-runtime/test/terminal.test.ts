import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Pty } from "@opencode/core/pty"
import { AbsolutePath } from "@opencode/schema/schema"
import type { TaskRealtime } from "@cybros/agent"
import { tmpdir } from "node:os"
import { location } from "../../core/test/fixture/location"
import { testEffect } from "../../core/test/lib/effect"
import { terminalSession } from "../src/terminal"
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
            answer_sdp: null,
            max_age_ms: 1000,
          },
        }
        const work = terminalSession(
          { pty: async () => pty },
          {
            workspace: "workspace",
            conversation: "conversation",
            run: "run",
            task: "terminal",
            directory: tmpdir(),
            signal: owner.signal,
            realtime: {
              read: async () => state.value,
              offer: async (input) => {
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
