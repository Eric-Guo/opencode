/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RunEntryContent, separatorRows } from "@/cli/cmd/run/scrollback.writer"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import type { StreamCommit } from "@/cli/cmd/run/types"

function toolPart(): ToolPart {
  return {
    id: "part-tool",
    type: "tool",
    tool: "glob",
    callID: "call-tool",
    messageID: "msg-tool",
    sessionID: "session-1",
    state: {
      status: "running",
      input: {
        pattern: "**/run.ts",
      },
      time: {
        start: 1,
      },
    },
  }
}

test("run entry content updates when live commit text changes", async () => {
  const [commit, setCommit] = createSignal<StreamCommit>({
    kind: "tool",
    text: "I",
    phase: "progress",
    source: "tool",
    messageID: "msg-1",
    partID: "part-1",
    tool: "bash",
  })

  const app = await testRender(() => (
    <box width={80} height={4}>
      <RunEntryContent commit={commit()} theme={RUN_THEME_FALLBACK} width={80} />
    </box>
  ), {
    width: 80,
    height: 4,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("I")

    setCommit({
      kind: "tool",
      text: "I need to inspect the codebase",
      phase: "progress",
      source: "tool",
      messageID: "msg-1",
      partID: "part-1",
      tool: "bash",
    })
    await app.renderOnce()

    expect(app.captureCharFrame()).toContain("I need to inspect the codebase")
  } finally {
    app.renderer.destroy()
  }
})

test("subagent rows use shared separator rules", async () => {
  const commits: StreamCommit[] = [
    {
      kind: "tool",
      source: "tool",
      messageID: "msg-tool",
      partID: "part-tool",
      tool: "glob",
      phase: "start",
      text: "running glob",
      toolState: "running",
      part: toolPart(),
    },
    {
      kind: "reasoning",
      source: "reasoning",
      messageID: "msg-reasoning",
      partID: "part-reasoning",
      phase: "progress",
      text: "Thinking:  Found it.",
    },
  ]

  expect(separatorRows(undefined, commits[0]!)).toBe(0)
  expect(separatorRows(commits[0], commits[1]!)).toBe(1)
})
