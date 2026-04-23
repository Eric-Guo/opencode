import { describe, expect, test } from "bun:test"
import { entryBody, entryCanStream, entryDone } from "@/cli/cmd/run/entry.body"
import type { StreamCommit } from "@/cli/cmd/run/types"

function commit(input: Partial<StreamCommit> & Pick<StreamCommit, "kind" | "text" | "phase" | "source">): StreamCommit {
  return input
}

describe("run entry body", () => {
  test("renders assistant progress as markdown", () => {
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
  })

  test("renders reasoning as markdown-highlighted code like the tui", () => {
    const body = entryBody(
      commit({
        kind: "reasoning",
        text: "Thinking: plan next steps",
        phase: "progress",
        source: "reasoning",
        partID: "reason-1",
      }),
    )

    expect(body).toEqual({
      type: "code",
      filetype: "markdown",
      content: "_Thinking:_ plan next steps",
    })
    expect(entryCanStream(commit({ kind: "reasoning", text: "Thinking: plan next steps", phase: "progress", source: "reasoning" }), body)).toBe(true)
  })

  test("prefixes user entries in text mode", () => {
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

  test("keeps completed write tool finals structured", () => {
    const body = entryBody(
      commit({
        kind: "tool",
        text: "",
        phase: "final",
        source: "tool",
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
      }),
    )

    expect(body.type).toBe("structured")
    if (body.type !== "structured") {
      throw new Error("expected structured body")
    }

    expect(body.snapshot).toEqual({
      kind: "code",
      title: "# Wrote src/a.ts",
      content: "const x = 1\n",
      file: "src/a.ts",
    })
    expect(entryDone(
      commit({
        kind: "tool",
        text: "output",
        phase: "progress",
        source: "tool",
        tool: "bash",
        toolState: "completed",
      }),
    )).toBe(true)
  })

  test("keeps completed edit tool finals structured", () => {
    const body = entryBody(
      commit({
        kind: "tool",
        text: "",
        phase: "final",
        source: "tool",
        tool: "edit",
        toolState: "completed",
        part: {
          id: "tool-2",
          sessionID: "session-1",
          messageID: "msg-2",
          type: "tool",
          callID: "call-2",
          tool: "edit",
          state: {
            status: "completed",
            input: {
              filePath: "src/a.ts",
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
      }),
    )

    expect(body.type).toBe("structured")
    if (body.type !== "structured") {
      throw new Error("expected structured body")
    }

    expect(body.snapshot).toEqual({
      kind: "diff",
      items: [
        {
          title: "# Edited src/a.ts",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          file: "src/a.ts",
        },
      ],
    })
  })

  test("keeps completed apply_patch tool finals structured", () => {
    const body = entryBody(
      commit({
        kind: "tool",
        text: "",
        phase: "final",
        source: "tool",
        tool: "apply_patch",
        toolState: "completed",
        part: {
          id: "tool-3",
          sessionID: "session-1",
          messageID: "msg-3",
          type: "tool",
          callID: "call-3",
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
      }),
    )

    expect(body.type).toBe("structured")
    if (body.type !== "structured") {
      throw new Error("expected structured body")
    }

    expect(body.snapshot).toEqual({
      kind: "diff",
      items: [
        {
          title: "# Patched src/a.ts",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          file: "src/a.ts",
          deletions: 0,
        },
      ],
    })
  })

  test("keeps running task tool state out of scrollback", () => {
    expect(
      entryBody(
        commit({
          kind: "tool",
          text: "running inspect reducer",
          phase: "start",
          source: "tool",
          tool: "task",
          toolState: "running",
          part: {
            id: "task-1",
            sessionID: "session-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "task",
            state: {
              status: "running",
              input: {
                description: "Inspect reducer",
                subagent_type: "explore",
              },
            },
          } as never,
        }),
      ),
    ).toEqual({
      type: "none",
    })
  })

  test("renders completed task tool finals from promoted task results", () => {
    expect(
      entryBody(
        commit({
          kind: "tool",
          text: "",
          phase: "final",
          source: "tool",
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
                description: "Inspect reducer",
                subagent_type: "explore",
              },
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
              time: {
                start: 1,
                end: 2,
              },
            },
          } as never,
        }),
      ),
    ).toEqual({
      type: "markdown",
      content: "# Findings\n\n- Footer stays live",
    })
  })

  test("falls back to structured task final when task result is empty", () => {
    const body = entryBody(
      commit({
        kind: "tool",
        text: "",
        phase: "final",
        source: "tool",
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
              description: "Inspect reducer",
              subagent_type: "explore",
            },
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
            time: {
              start: 1,
              end: 2,
            },
          },
        } as never,
      }),
    )

    expect(body.type).toBe("structured")
    if (body.type !== "structured") {
      throw new Error("expected structured body")
    }

    expect(body.snapshot).toEqual({
      kind: "task",
      title: "# Explore Task",
      rows: ["Inspect reducer"],
      tail: "",
    })
  })

  test("streams tool progress text", () => {
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
    expect(entryCanStream(commit({ kind: "tool", text: "partial output", phase: "progress", source: "tool", tool: "bash" }), body)).toBe(true)
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
