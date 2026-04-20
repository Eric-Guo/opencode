import { afterEach, expect, test } from "bun:test"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { RunScrollbackStream } from "@/cli/cmd/run/scrollback.surface"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"

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

function renderCommit(commit: ClaimedCommit): string {
  return decoder.decode(commit.snapshot.getRealCharBytes(true)).replace(/ +\n/g, "\n")
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
    expect(progress[0]!.snapshot.height).toBe(5)
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

test("streamed assistant final leaves newline ownership to the next entry", async () => {
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
    kind: "assistant",
    text: "hello",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })
  destroyCommits(claimCommits(out.renderer))

  await scrollback.append({
    kind: "assistant",
    text: "",
    phase: "final",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })

  const final = claimCommits(out.renderer)
  try {
    expect(final).toHaveLength(1)
    expect(final[0]!.trailingNewline).toBe(false)
  } finally {
    destroyCommits(final)
  }
})

test("preserves blank rows between streamed markdown block commits", async () => {
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
    text: "# Title\n\nPara 1\n\n",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })

  const first = claimCommits(out.renderer)
  expect(first).toHaveLength(1)

  await scrollback.append({
    kind: "assistant",
    text: "> Quote",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })

  const second = claimCommits(out.renderer)
  expect(second).toHaveLength(0)

  await scrollback.complete()

  const final = claimCommits(out.renderer)
  try {
    expect(final).toHaveLength(1)

    const rendered = [...first, ...final]
      .map((item) => decoder.decode(item.snapshot.getRealCharBytes(true)).replace(/ +\n/g, "\n"))
      .join("")
    expect(rendered).toContain("# Title\n\nPara 1\n\n> Quote")
  } finally {
    destroyCommits(first)
    destroyCommits(final)
  }
})

test("renders write finals without a redundant start row", async () => {
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
    phase: "start",
    source: "tool",
    partID: "tool-1",
    messageID: "msg-1",
    tool: "write",
    toolState: "running",
    part: {
      id: "tool-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "write",
      state: {
        status: "running",
        input: {
          filePath: "src/a.ts",
          content: "const x = 1\n",
        },
        time: {
          start: 1,
        },
      },
    } as never,
  })

  const start = claimCommits(out.renderer)
  try {
    expect(start).toHaveLength(0)
  } finally {
    destroyCommits(start)
  }

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "tool-1",
    messageID: "msg-1",
    tool: "write",
    toolState: "completed",
    part: {
      id: "tool-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "write",
      state: {
        status: "completed",
        input: {
          filePath: "src/a.ts",
          content: "const x = 1\n",
        },
        metadata: {},
        time: {
          start: 1,
          end: 2,
        },
      },
    } as never,
  })

  const final = claimCommits(out.renderer)
  try {
    expect(final).toHaveLength(1)
    expect(renderCommit(final[0]!)).toContain("# Wrote src/a.ts")
  } finally {
    destroyCommits(final)
  }
})

test("renders edit finals without a redundant start row", async () => {
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
    phase: "start",
    source: "tool",
    partID: "tool-edit",
    messageID: "msg-edit",
    tool: "edit",
    toolState: "running",
    part: {
      id: "tool-edit",
      sessionID: "session-1",
      messageID: "msg-edit",
      type: "tool",
      callID: "call-edit",
      tool: "edit",
      state: {
        status: "running",
        input: {
          filePath: "src/a.ts",
          oldString: "old",
          newString: "new",
        },
        time: {
          start: 1,
        },
      },
    } as never,
  })

  expect(claimCommits(out.renderer)).toHaveLength(0)

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "tool-edit",
    messageID: "msg-edit",
    tool: "edit",
    toolState: "completed",
    part: {
      id: "tool-edit",
      sessionID: "session-1",
      messageID: "msg-edit",
      type: "tool",
      callID: "call-edit",
      tool: "edit",
      state: {
        status: "completed",
        input: {
          filePath: "src/a.ts",
          oldString: "old",
          newString: "new",
        },
        metadata: {
          diff: "@@ -1 +1 @@\n-old\n+new\n",
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
    expect(commits).toHaveLength(1)
    expect(renderCommit(commits[0]!)).toContain("# Edited src/a.ts")
  } finally {
    destroyCommits(commits)
  }
})

test("renders apply_patch finals without a redundant start row", async () => {
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
    phase: "start",
    source: "tool",
    partID: "tool-patch",
    messageID: "msg-patch",
    tool: "apply_patch",
    toolState: "running",
    part: {
      id: "tool-patch",
      sessionID: "session-1",
      messageID: "msg-patch",
      type: "tool",
      callID: "call-patch",
      tool: "apply_patch",
      state: {
        status: "running",
        input: {},
        metadata: {
          files: [
            {
              type: "update",
              filePath: "src/a.ts",
              relativePath: "src/a.ts",
              patch: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
        },
        time: {
          start: 1,
        },
      },
    } as never,
  })

  expect(claimCommits(out.renderer)).toHaveLength(0)

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "tool-patch",
    messageID: "msg-patch",
    tool: "apply_patch",
    toolState: "completed",
    part: {
      id: "tool-patch",
      sessionID: "session-1",
      messageID: "msg-patch",
      type: "tool",
      callID: "call-patch",
      tool: "apply_patch",
      state: {
        status: "completed",
        input: {},
        metadata: {
          files: [
            {
              type: "update",
              filePath: "src/a.ts",
              relativePath: "src/a.ts",
              patch: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
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
    expect(commits).toHaveLength(1)
    expect(renderCommit(commits[0]!)).toContain("# Patched src/a.ts")
  } finally {
    destroyCommits(commits)
  }
})

test("inserts a spacer between block assistant entries and following inline tools", async () => {
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
    kind: "assistant",
    text: "hello",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })
  await scrollback.complete()

  const first = claimCommits(out.renderer)
  try {
    expect(first).toHaveLength(1)
    expect(renderCommit(first[0]!).trim()).toBe("hello")
  } finally {
    destroyCommits(first)
  }

  await scrollback.append({
    kind: "tool",
    source: "tool",
    messageID: "msg-tool",
    partID: "part-tool",
    tool: "glob",
    phase: "start",
    text: "running glob",
    toolState: "running",
    part: {
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
    } as never,
  })

  const next = claimCommits(out.renderer)
  try {
    expect(next).toHaveLength(2)
    expect(renderCommit(next[0]!).trim()).toBe("")
    expect(renderCommit(next[1]!).replace(/ +/g, " ").trim()).toBe('✱ Glob "**/run.ts"')
  } finally {
    destroyCommits(next)
  }
})

test("renders todos without redundant start or footer lines", async () => {
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
    text: "",
    phase: "start",
    source: "tool",
    partID: "todo-1",
    messageID: "msg-1",
    tool: "todowrite",
    toolState: "running",
    part: {
      id: "todo-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "todowrite",
      state: {
        status: "running",
        input: {
          todos: [
            { status: "completed", content: "List files under `run/`" },
            { status: "in_progress", content: "Count functions in each `run/` file" },
            { status: "pending", content: "Mark each tracking item complete" },
          ],
        },
        time: {
          start: 1,
        },
      },
    } as never,
  })

  expect(claimCommits(out.renderer)).toHaveLength(0)

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "todo-1",
    messageID: "msg-1",
    tool: "todowrite",
    toolState: "completed",
    part: {
      id: "todo-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "todowrite",
      state: {
        status: "completed",
        input: {
          todos: [
            { status: "completed", content: "List files under `run/`" },
            { status: "in_progress", content: "Count functions in each `run/` file" },
            { status: "pending", content: "Mark each tracking item complete" },
          ],
        },
        metadata: {},
        time: {
          start: 1,
          end: 4,
        },
      },
    } as never,
  })

  const commits = claimCommits(out.renderer)
  try {
    expect(commits).toHaveLength(1)
    const raw = decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))
    const rows = Array.from({ length: commits[0]!.snapshot.height }, (_, index) =>
      raw.slice(index * 80, (index + 1) * 80).trimEnd(),
    )
    const rendered = rows.join("\n")
    expect(rendered).toContain("# Todos")
    expect(rendered).toContain("[✓] List files under `run/`")
    expect(rendered).toContain("[•] Count functions in each `run/` file")
    expect(rendered).toContain("[ ] Mark each tracking item complete")
    expect(rendered).not.toContain("Updating")
    expect(rendered).not.toContain("todos completed")
    expect(rows).toContain("[✓] List files under `run/`")
    expect(rows).toContain("[•] Count functions in each `run/` file")
    expect(rows).toContain("[ ] Mark each tracking item complete")
  } finally {
    destroyCommits(commits)
  }
})

test("renders questions without redundant start or footer lines", async () => {
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
    text: "",
    phase: "start",
    source: "tool",
    partID: "question-1",
    messageID: "msg-1",
    tool: "question",
    toolState: "running",
    part: {
      id: "question-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "question",
      state: {
        status: "running",
        input: {
          questions: [
            {
              question: "What should I work on in the codebase next?",
              header: "Next work",
              options: [{ label: "bug", description: "Bug fix" }],
              multiple: false,
            },
          ],
        },
        time: {
          start: 1,
        },
      },
    } as never,
  })

  expect(claimCommits(out.renderer)).toHaveLength(0)

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "question-1",
    messageID: "msg-1",
    tool: "question",
    toolState: "completed",
    part: {
      id: "question-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "question",
      state: {
        status: "completed",
        input: {
          questions: [
            {
              question: "What should I work on in the codebase next?",
              header: "Next work",
              options: [{ label: "bug", description: "Bug fix" }],
              multiple: false,
            },
          ],
        },
        metadata: {
          answers: [["Bug fix"]],
        },
        time: {
          start: 1,
          end: 2100,
        },
      },
    } as never,
  })

  const commits = claimCommits(out.renderer)
  try {
    expect(commits).toHaveLength(1)
    const raw = decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))
    const rows = Array.from({ length: commits[0]!.snapshot.height }, (_, index) =>
      raw.slice(index * 80, (index + 1) * 80).trimEnd(),
    )
    const rendered = rows.join("\n")
    expect(rendered).toContain("# Questions")
    expect(rendered).toContain("What should I work on in the codebase next?")
    expect(rendered).toContain("Bug fix")
    expect(rendered).not.toContain("Asked")
    expect(rendered).not.toContain("questions completed")
    expect(rows).toContain("What should I work on in the codebase next?")
    expect(rows).toContain("Bug fix")
  } finally {
    destroyCommits(commits)
  }
})

test("bodyless starts keep the previous rendered item as separator context", async () => {
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
    kind: "assistant",
    text: "hello",
    phase: "progress",
    source: "assistant",
    messageID: "msg-1",
    partID: "part-1",
  })
  await scrollback.complete()
  destroyCommits(claimCommits(out.renderer))

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "start",
    source: "tool",
    partID: "task-1",
    messageID: "msg-2",
    tool: "task",
    toolState: "running",
    part: {
      id: "task-1",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "tool",
      callID: "call-2",
      tool: "task",
      state: {
        status: "running",
        input: {
          description: "Explore run.ts",
          subagent_type: "explore",
        },
        time: {
          start: 1,
        },
      },
    } as never,
  })

  expect(claimCommits(out.renderer)).toHaveLength(0)

  await scrollback.append({
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    partID: "task-1",
    messageID: "msg-2",
    tool: "task",
    toolState: "error",
    part: {
      id: "task-1",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "tool",
      callID: "call-2",
      tool: "task",
      state: {
        status: "error",
        input: {
          description: "Explore run.ts",
          subagent_type: "explore",
        },
        error: "boom",
        time: {
          start: 1,
          end: 2,
        },
      },
    } as never,
  })

  const final = claimCommits(out.renderer)
  try {
    expect(final).toHaveLength(2)
    expect(renderCommit(final[0]!).trim()).toBe("")
    expect(renderCommit(final[1]!)).toContain("failed")
  } finally {
    destroyCommits(final)
  }
})

test("streamed assistant blocks defer their spacer until first render", async () => {
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
    kind: "user",
    text: "use subagent to explore run.ts",
    phase: "start",
    source: "system",
  })
  destroyCommits(claimCommits(out.renderer))

  for (const chunk of ["Exploring", " run.ts", " via", " a codebase-aware", " subagent next."]) {
    await scrollback.append({
      kind: "assistant",
      text: chunk,
      phase: "progress",
      source: "assistant",
      messageID: "msg-1",
      partID: "part-1",
    })
  }

  const progress = claimCommits(out.renderer)
  try {
    expect(progress).toHaveLength(0)
  } finally {
    destroyCommits(progress)
  }

  await scrollback.complete()

  const final = claimCommits(out.renderer)
  try {
    expect(final).toHaveLength(2)
    expect(renderCommit(final[0]!).trim()).toBe("")
    expect(renderCommit(final[1]!).replace(/\n/g, " ")).toContain(
      "Exploring run.ts via a codebase-aware subagent next.",
    )
  } finally {
    destroyCommits(final)
  }
})

test("first entry after prior scrollback gets a spacer", async () => {
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
    wrote: true,
  })

  await scrollback.append({
    kind: "user",
    text: "use subagent to explore run.ts",
    phase: "start",
    source: "system",
  })

  const commits = claimCommits(out.renderer)
  try {
    expect(commits).toHaveLength(2)
    expect(renderCommit(commits[0]!).trim()).toBe("")
    expect(renderCommit(commits[1]!).trim()).toBe("› use subagent to explore run.ts")
  } finally {
    destroyCommits(commits)
  }
})

test("first streamed entry after prior scrollback gets a spacer", async () => {
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
    wrote: true,
  })

  for (const chunk of ["Exploring", " run.ts", " via", " a codebase-aware", " subagent next."]) {
    await scrollback.append({
      kind: "assistant",
      text: chunk,
      phase: "progress",
      source: "assistant",
      messageID: "msg-1",
      partID: "part-1",
    })
  }

  const progress = claimCommits(out.renderer)
  try {
    expect(progress).toHaveLength(0)
  } finally {
    destroyCommits(progress)
  }

  await scrollback.complete()

  const commits = claimCommits(out.renderer)
  try {
    expect(commits).toHaveLength(2)
    expect(renderCommit(commits[0]!).trim()).toBe("")
    expect(renderCommit(commits[1]!).replace(/\n/g, " ")).toContain(
      "Exploring run.ts via a codebase-aware subagent next.",
    )
  } finally {
    destroyCommits(commits)
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
    expect(rendered).toContain("Summary:")
    expect(rendered).toContain("Local interactive mode")
  } finally {
    destroyCommits(commits)
  }
})
