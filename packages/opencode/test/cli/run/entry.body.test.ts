import { describe, expect, test } from "bun:test"
import { entryBody, entryCanStream, entryDone } from "../../../src/cli/cmd/run/entry.body"
import type { StreamCommit } from "../../../src/cli/cmd/run/types"

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
