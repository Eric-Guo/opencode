import { afterEach, expect, test } from "bun:test"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { RunFooter } from "../../../src/cli/cmd/run/footer"
import { RUN_THEME_FALLBACK } from "../../../src/cli/cmd/run/theme"

const decoder = new TextDecoder()
const active: Array<{ footer?: RunFooter; renderer: TestRenderer }> = []

afterEach(() => {
  for (const item of active.splice(0)) {
    item.footer?.destroy()
    item.renderer.destroy()
  }
})

function createFooter(renderer: TestRenderer) {
  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  return new RunFooter(renderer, {
    directory: "/tmp",
    findFiles: async () => [],
    agents: [],
    resources: [],
    sessionID: () => "session-1",
    agentLabel: "Build",
    modelLabel: "Model default",
    first: false,
    history: [],
    theme: RUN_THEME_FALLBACK,
    keybinds: {
      leader: "",
      variantCycle: "tab",
      interrupt: "esc",
      historyPrevious: "up",
      historyNext: "down",
      inputSubmit: "enter",
      inputNewline: "shift+enter",
    },
    diffStyle: "auto",
    onPermissionReply: () => {},
    onQuestionReply: () => {},
    onQuestionReject: () => {},
    treeSitterClient,
  })
}

test("run footer class loads", () => {
  expect(typeof RunFooter).toBe("function")
})

test("run footer finalizes streamed markdown tables when the turn goes idle", async () => {
  const out = await createTestRenderer({
    width: 80,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  const footer = createFooter(out.renderer)
  active.push({ footer, renderer: out.renderer })
  const lib = Reflect.get(out.renderer, "lib") as {
    commitSplitFooterSnapshot: (...args: unknown[]) => unknown
  }
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  let payload = ""

  lib.commitSplitFooterSnapshot = (...args: unknown[]) => {
    const snapshot = args[1] as {
      getRealCharBytes(addLineBreaks?: boolean): Uint8Array
    }
    payload += decoder.decode(snapshot.getRealCharBytes(true))
    return originalCommitSplitFooterSnapshot(...args)
  }

  try {
    footer.event({ type: "turn.send", queue: 0 })

    const text = "| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n| Row 1 | Value 1 | Value 2 |\n| Row 2 | Value 3 | Value 4 |"
    for (const chunk of text) {
      footer.append({
        kind: "assistant",
        text: chunk,
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "part-1",
      })
    }

    footer.event({ type: "turn.idle", queue: 0 })
    await footer.idle()

    expect(payload).toContain("Column 1")
    expect(payload).toContain("Row 2")
    expect(payload).toContain("Value 4")
  } finally {
    lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  }
})

test("run footer keeps active streamed assistant content across width resize", async () => {
  const out = await createTestRenderer({
    width: 40,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  const footer = createFooter(out.renderer)
  active.push({ footer, renderer: out.renderer })
  const lib = Reflect.get(out.renderer, "lib") as {
    commitSplitFooterSnapshot: (...args: unknown[]) => unknown
  }
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  let payload = ""

  lib.commitSplitFooterSnapshot = (...args: unknown[]) => {
    const snapshot = args[1] as {
      getRealCharBytes(addLineBreaks?: boolean): Uint8Array
    }
    payload += decoder.decode(snapshot.getRealCharBytes(true))
    return originalCommitSplitFooterSnapshot(...args)
  }

  try {
    footer.event({ type: "turn.send", queue: 0 })

    footer.append({
      kind: "assistant",
      text: "This paragraph only existed in the active surface until finalization.",
      phase: "progress",
      source: "assistant",
      messageID: "msg-2",
      partID: "part-2",
    })

    out.resize(60, 24)

    footer.event({ type: "turn.idle", queue: 0 })
    await footer.idle()

    expect(payload.replace(/\s+/g, " ").trim()).toContain(
      "This paragraph only existed in the active surface until finalization.",
    )
  } finally {
    lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  }
})
