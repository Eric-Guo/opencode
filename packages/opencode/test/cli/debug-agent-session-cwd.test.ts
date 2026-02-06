import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { Agent } from "../../src/agent/agent"
import { executeDebugTool } from "../../src/cli/cmd/debug/agent"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("debug agent session_cwd", () => {
  test("runs tool execution in agent session_cwd", async () => {
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
                model: "opencode/big-pickle",
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
        const agent = await Agent.get("build")
        if (!agent) throw new Error("expected build agent")
        const result = await executeDebugTool({
          agent,
          tool: {
            id: "fake",
            description: "fake",
            parameters: z.object({}),
            execute: async () => ({
              title: "ok",
              metadata: {
                cwd: Instance.directory,
              },
              output: Instance.directory,
            }),
          },
          params: {},
        })

        expect(result.output).toBe(tmp.extra)
        expect(result.metadata).toEqual(expect.objectContaining({ cwd: tmp.extra }))
      },
    })
  })
})
