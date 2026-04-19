import { afterEach, expect, test } from "bun:test"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { RunScrollbackStream } from "../../../src/cli/cmd/run/scrollback.surface"
import { RUN_THEME_FALLBACK } from "../../../src/cli/cmd/run/theme"

type ClaimedCommit = {
  snapshot: {
    height: number
    getRealCharBytes(addLineBreaks?: boolean): Uint8Array
    destroy(): void
  }
  trailingNewline: boolean
}

const decoder = new TextDecoder()
const active: TestRenderer[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) {
    renderer.destroy()
  }
})

function claimCommits(renderer: TestRenderer): ClaimedCommit[] {
  return (renderer as any).externalOutputQueue.claim() as ClaimedCommit[]
}

function destroyCommits(commits: ClaimedCommit[]) {
  for (const commit of commits) {
    commit.snapshot.destroy()
  }
}

test("completes finely streamed markdown tables when the turn goes idle", async () => {
  const out = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  const scrollback = new RunScrollbackStream(out.renderer, RUN_THEME_FALLBACK, {
    treeSitterClient,
  })

  const text = "| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n| Row 1 | Value 1 | Value 2 |\n| Row 2 | Value 3 | Value 4 |"

  for (const chunk of text) {
    await scrollback.append({
      kind: "assistant",
      text: chunk,
      phase: "progress",
      source: "assistant",
      messageID: "msg-1",
      partID: "part-1",
    })
  }

  await scrollback.complete()

  const commits = claimCommits(out.renderer)
  try {
    expect(commits.length).toBeGreaterThan(0)
    const rendered = commits.map((item) => decoder.decode(item.snapshot.getRealCharBytes(true))).join("\n")
    expect(rendered).toContain("Column 1")
    expect(rendered).toContain("Row 2")
    expect(rendered).toContain("Value 4")
  } finally {
    destroyCommits(commits)
  }
})

test("completes coalesced markdown tables after one progress append", async () => {
  const out = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  const scrollback = new RunScrollbackStream(out.renderer, RUN_THEME_FALLBACK, {
    treeSitterClient,
  })

  await scrollback.append({
    kind: "assistant",
    text: "| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n| Row 1 | Value 1 | Value 2 |\n| Row 2 | Value 3 | Value 4 |",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })

  await scrollback.complete()

  const commits = claimCommits(out.renderer)
  try {
    expect(commits.length).toBeGreaterThan(0)
    const rendered = commits.map((item) => decoder.decode(item.snapshot.getRealCharBytes(true))).join("\n")
    expect(rendered).toContain("Column 1")
    expect(rendered).toContain("Row 2")
    expect(rendered).toContain("Value 4")
  } finally {
    destroyCommits(commits)
  }
})

test("completes markdown replies without adding a second blank line above the footer", async () => {
  const out = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  const scrollback = new RunScrollbackStream(out.renderer, RUN_THEME_FALLBACK, {
    treeSitterClient,
    wrote: false,
  })

  await scrollback.append({
    kind: "assistant",
    text: "# Markdown Sample\n\n- Item 1\n- Item 2\n\n```js\nconst message = \"Hello, markdown\"\nconsole.log(message)\n```",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })

  const progress = claimCommits(out.renderer)
  try {
    expect(progress).toHaveLength(1)
    expect(progress[0]!.snapshot.height).toBe(4)
    const rendered = decoder.decode(progress[0]!.snapshot.getRealCharBytes(true))
    expect(rendered).toContain("Markdown Sample")
    expect(rendered).toContain("Item 2")
    expect(rendered).not.toContain("console.log(message)")
  } finally {
    destroyCommits(progress)
  }

  await scrollback.complete()

  const final = claimCommits(out.renderer)
  try {
    expect(final).toHaveLength(1)
    expect(final[0]!.trailingNewline).toBe(false)
    const rendered = decoder.decode(final[0]!.snapshot.getRealCharBytes(true))
    expect(rendered).toContain('const message = "Hello, markdown"')
    expect(rendered).toContain("console.log(message)")
  } finally {
    destroyCommits(final)
  }
})

test("coalesces same-line tool progress into one snapshot", async () => {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const scrollback = new RunScrollbackStream(out.renderer, RUN_THEME_FALLBACK, {
    wrote: false,
  })

  await scrollback.append({
    kind: "tool",
    text: "abc",
    phase: "progress",
    source: "tool",
    partID: "tool-1",
    messageID: "msg-1",
    tool: "bash",
  })
  await scrollback.append({
    kind: "tool",
    text: "def",
    phase: "progress",
    source: "tool",
    partID: "tool-1",
    messageID: "msg-1",
    tool: "bash",
  })
  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "tool-1",
    messageID: "msg-1",
    tool: "bash",
    toolState: "completed",
  })

  const commits = claimCommits(out.renderer)
  try {
    expect(commits).toHaveLength(1)
    expect(decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))).toContain("abcdef")
  } finally {
    destroyCommits(commits)
  }
})

test("renders structured write finals as native code blocks", async () => {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  const scrollback = new RunScrollbackStream(out.renderer, RUN_THEME_FALLBACK, {
    treeSitterClient,
    wrote: false,
  })

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "tool-2",
    messageID: "msg-2",
    tool: "write",
    toolState: "completed",
    part: {
      id: "tool-2",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "tool",
      callID: "call-2",
      tool: "write",
      state: {
        status: "completed",
        input: {
          filePath: "src/a.ts",
          content: "const x = 1\nconst y = 2\n",
        },
        metadata: {},
        time: {
          start: 1,
          end: 2,
        },
      },
    } as never,
  })

  const commits = claimCommits(out.renderer)
  try {
    expect(commits).toHaveLength(1)
    const rendered = decoder.decode(commits[0]!.snapshot.getRealCharBytes(true)).replace(/ +/g, " ")
    expect(rendered).toContain("# Wrote src/a.ts")
    expect(rendered).toMatch(/1\s+const x = 1/)
    expect(rendered).toMatch(/2\s+const y = 2/)
  } finally {
    destroyCommits(commits)
  }
})

test("renders promoted task-result markdown without leading blank rows", async () => {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  const scrollback = new RunScrollbackStream(out.renderer, RUN_THEME_FALLBACK, {
    treeSitterClient,
    wrote: false,
  })

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "task-1",
    messageID: "msg-1",
    tool: "task",
    toolState: "completed",
    part: {
      id: "task-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "task",
      state: {
        status: "completed",
        input: {
          description: "Explore run.ts",
          subagent_type: "explore",
        },
        output: [
          "task_id: child-1 (for resuming to continue this task if needed)",
          "",
          "<task_result>",
          "Location: `/tmp/run.ts`",
          "",
          "Summary:",
          "- Local interactive mode",
          "- Attach mode",
          "</task_result>",
        ].join("\n"),
        metadata: {
          sessionId: "child-1",
        },
        time: {
          start: 1,
          end: 2,
        },
      },
    } as never,
  })

  const commits = claimCommits(out.renderer)
  try {
    expect(commits.length).toBeGreaterThan(0)
    const rendered = commits.map((item) => decoder.decode(item.snapshot.getRealCharBytes(true))).join("")
    expect(rendered.startsWith("\n")).toBe(false)
    expect(rendered.split("\n")[0]?.trim()).toBe("Location: `/tmp/run.ts`")
    expect(rendered).toContain("Summary:")
    expect(rendered).toContain("Local interactive mode")
  } finally {
    destroyCommits(commits)
  }
})
