import { expect, test } from "bun:test"
import { RunnerAdmission } from "../src/runner"
import { RunnerInbox } from "../src/runner-inbox"
import { definition } from "../src/extensions"
import { executorFixture } from "./fixture/executor"

test.each(["opencode.environment", "opencode.mcp"])("agent tools retain the inherited anchor from %s", async (key) => {
  const fixture = await executorFixture()
  const runner = new RunnerInbox({
    executor: fixture.client,
    id: "executor",
    root: fixture.directory,
    journal: fixture.journal,
    signal: new AbortController().signal,
    admission: new RunnerAdmission(),
    wake() {},
    extensions: () => [
      {
        role: "agent",
        definition: definition("inherited", "Inherited editor attachment", {}, []),
        async execute(_input, context) {
          return {
            content: JSON.stringify({
              anchor: context.anchor,
              conversation: context.conversation,
              directory: context.directory,
            }),
          }
        },
      },
    ],
  })
  fixture.add("run", "task", "inherited", {
    conversation_public_id: "child",
    executor_context: {
      [key]: { anchor: "parent", ...(key === "opencode.environment" ? { root: fixture.directory } : {}) },
    },
    addressed_to: { role: "agent", executor_public_id: "executor", presence: "online", last_seen_at: null },
  })
  try {
    await runner.sweep()
    await runner.drain()
    expect(fixture.commits).toHaveLength(1)
    expect(fixture.commits[0].body).toMatchObject({
      outcome: "completed",
      content: JSON.stringify({ anchor: "parent", conversation: "child", directory: fixture.directory }),
    })
  } finally {
    await runner.close()
    await fixture.close()
  }
})
