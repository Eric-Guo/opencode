import { expect, test } from "bun:test"
import { Effect } from "effect"
import { executeToolEffect } from "../../src/cli/cmd/debug/agent"

test("executeToolEffect resolves Effect results for debug tool execution", async () => {
  const result = await executeToolEffect(
    Effect.succeed({
      title: "glob",
      metadata: {
        count: 1,
      },
      output: "/tmp/example.ts",
    }),
  )

  expect(result).toEqual({
    title: "glob",
    metadata: {
      count: 1,
    },
    output: "/tmp/example.ts",
  })
})
