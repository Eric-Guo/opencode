import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { entryBody, entryCanStream, entryDone } from "@/cli/cmd/run/entry.body"
import type { StreamCommit, ToolSnapshot } from "@/cli/cmd/run/types"

function commit(input: Partial<StreamCommit> & Pick<StreamCommit, "kind" | "text" | "phase" | "source">): StreamCommit {
  return input
}

function toolPart(tool: string, state: ToolPart["state"], id = `${tool}-1`, messageID = `msg-${tool}`): ToolPart {
  return {
    id,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID: `call-${id}`,
    tool,
    state,
  } as ToolPart
}

function toolCommit(input: {
  tool: string
  state: ToolPart["state"]
  phase?: StreamCommit["phase"]
  toolState?: StreamCommit["toolState"]
  text?: string
  id?: string
  messageID?: string
}) {
  return commit({
    kind: "tool",
    text: input.text ?? "",
    phase: input.phase ?? "final",
    source: "tool",
    tool: input.tool,
    toolState: input.toolState ?? "completed",
    part: toolPart(input.tool, input.state, input.id, input.messageID),
  })
}

function structured(next: StreamCommit) {
  const body = entryBody(next)
  expect(body.type).toBe("structured")
  if (body.type !== "structured") {
    throw new Error("expected structured body")
  }

  return body.snapshot
}

describe("run entry body", () => {
  test("renders assistant, reasoning, and user entries in their display formats", () => {
    expect(
      entryBody(
        commit({
          kind: "assistant",
          text: "# Title\n\nHello **world**",
          phase: "progress",
          source: "assistant",
          partID: "part-1",
        }),
      ),
    ).toEqual({
      type: "markdown",
      content: "# Title\n\nHello **world**",
    })

    const reasoning = entryBody(
      commit({
        kind: "reasoning",
        text: "Thinking: plan next steps",
        phase: "progress",
        source: "reasoning",
        partID: "reason-1",
      }),
    )
    expect(reasoning).toEqual({
      type: "code",
      filetype: "markdown",
      content: "_Thinking:_ plan next steps",
    })
    expect(
      entryCanStream(
        commit({
          kind: "reasoning",
          text: "Thinking: plan next steps",
          phase: "progress",
          source: "reasoning",
        }),
        reasoning,
      ),
    ).toBe(true)

    expect(
      entryBody(
        commit({
          kind: "user",
          text: "Inspect footer tabs",
          phase: "start",
          source: "system",
        }),
      ),
    ).toEqual({
      type: "text",
      content: "› Inspect footer tabs",
    })
  })

  for (const item of [
    {
      name: "keeps completed write tool finals structured",
      commit: toolCommit({
        tool: "write",
        state: {
          status: "completed",
          input: {
            filePath: "src/a.ts",
            content: "const x = 1\n",
          },
          output: "",
          title: "",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
      snapshot: {
        kind: "code",
        title: "# Wrote src/a.ts",
        content: "const x = 1\n",
        file: "src/a.ts",
      },
    },
    {
      name: "keeps completed edit tool finals structured",
      commit: toolCommit({
        tool: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "src/a.ts",
          },
          output: "",
          title: "",
          metadata: {
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
          time: { start: 1, end: 2 },
        },
      }),
      snapshot: {
        kind: "diff",
        items: [
          {
            title: "# Edited src/a.ts",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            file: "src/a.ts",
          },
        ],
      },
    },
    {
      name: "keeps completed apply_patch tool finals structured",
      commit: toolCommit({
        tool: "apply_patch",
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
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
          time: { start: 1, end: 2 },
        },
      }),
      snapshot: {
        kind: "diff",
        items: [
          {
            title: "# Patched src/a.ts",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            file: "src/a.ts",
            deletions: 0,
          },
        ],
        },
      },
  ] satisfies Array<{ name: string; commit: StreamCommit; snapshot: ToolSnapshot }>) {
    test(item.name, () => {
      expect(structured(item.commit)).toEqual(item.snapshot)
    })
  }

  test("keeps running task tool state out of scrollback", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "task",
          phase: "start",
          toolState: "running",
          text: "running inspect reducer",
          state: {
            status: "running",
            input: {
              description: "Inspect reducer",
              subagent_type: "explore",
            },
            time: { start: 1 },
          },
        }),
      ),
    ).toEqual({
      type: "none",
    })
  })

  test("promotes task results to markdown and falls back to structured task summaries", () => {
    expect(
      entryBody(
        toolCommit({
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Inspect reducer",
              subagent_type: "explore",
            },
            title: "",
            output: [
              "task_id: child-1 (for resuming to continue this task if needed)",
              "",
              "<task_result>",
              "# Findings\n\n- Footer stays live",
              "</task_result>",
            ].join("\n"),
            metadata: {
              sessionId: "child-1",
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      type: "markdown",
      content: "# Findings\n\n- Footer stays live",
    })

    expect(
      structured(
        toolCommit({
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Inspect reducer",
              subagent_type: "explore",
            },
            title: "",
            output: [
              "task_id: child-1 (for resuming to continue this task if needed)",
              "",
              "<task_result>",
              "",
              "</task_result>",
            ].join("\n"),
            metadata: {
              sessionId: "child-1",
            },
            time: { start: 1, end: 2 },
          },
        }),
      ),
    ).toEqual({
      kind: "task",
      title: "# Explore Task",
      rows: ["Inspect reducer"],
      tail: "",
    })
  })

  test("streams tool progress text and treats completed progress as done", () => {
    const body = entryBody(
      commit({
        kind: "tool",
        text: "partial output",
        phase: "progress",
        source: "tool",
        tool: "bash",
        partID: "tool-2",
      }),
    )

    expect(body).toEqual({
      type: "text",
      content: "partial output",
    })
    expect(
      entryCanStream(
        commit({
          kind: "tool",
          text: "partial output",
          phase: "progress",
          source: "tool",
          tool: "bash",
        }),
        body,
      ),
    ).toBe(true)
    expect(
      entryDone(
        commit({
          kind: "tool",
          text: "output",
          phase: "progress",
          source: "tool",
          tool: "bash",
          toolState: "completed",
        }),
      ),
    ).toBe(true)
  })

  test("renders interrupted assistant finals as text", () => {
    expect(
      entryBody(
        commit({
          kind: "assistant",
          text: "",
          phase: "final",
          source: "assistant",
          interrupted: true,
          partID: "part-1",
        }),
      ),
    ).toEqual({
      type: "text",
      content: "assistant interrupted",
    })
  })
})
