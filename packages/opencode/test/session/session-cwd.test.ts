import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { GlobalBus } from "../../src/bus/global"
import { tmpdir } from "../fixture/fixture"

type GlobalEvent = {
  directory?: string
  payload: {
    type: string
    properties?: {
      info?: {
        sessionID?: string
      }
    }
  }
}

describe("session_cwd", () => {
  test("shell uses agent session_cwd in regular sessions", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const cwd = path.join(dir, "knowledge", "7777")
        await fs.mkdir(cwd, { recursive: true })
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              build: {
                session_cwd: cwd,
              },
            },
          }),
        )
        return cwd
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await SessionPrompt.shell({
          sessionID: session.id,
          agent: "build",
          model: {
            providerID: "opencode",
            modelID: "big-pickle",
          },
          command: "pwd",
        })

        const tool = msg.parts.find((part) => part.type === "tool")
        expect(tool?.type).toBe("tool")
        if (!tool || tool.type !== "tool" || tool.state.status !== "completed") {
          throw new Error("expected completed tool part")
        }
        expect(tool.state.output).toContain(tmp.extra)
        expect(msg.info.path.cwd).toBe(tmp.extra)
      },
    })
  })

  test("global event directory stays on the session directory for session_cwd runs", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const cwd = path.join(dir, "knowledge", "7777")
        await fs.mkdir(cwd, { recursive: true })
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              build: {
                session_cwd: cwd,
              },
            },
          }),
        )
        return cwd
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const events: GlobalEvent[] = []
        const handler = (event: GlobalEvent) => {
          events.push(event)
        }

        await (async () => {
          GlobalBus.on("event", handler)
          const session = await Session.create({})
          await SessionPrompt.shell({
            sessionID: session.id,
            agent: "build",
            model: {
              providerID: "opencode",
              modelID: "big-pickle",
            },
            command: "pwd",
          })

          const message = events.find(
            (event) =>
              event.payload.type === "message.updated" && event.payload.properties?.info?.sessionID === session.id,
          )
          expect(message).toBeDefined()
          expect(message?.directory).toBe(tmp.path)
        })().finally(() => {
          GlobalBus.off("event", handler)
        })
      },
    })
  })
})
