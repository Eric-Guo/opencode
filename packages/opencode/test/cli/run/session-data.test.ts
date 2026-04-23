import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { createSessionData, flushInterrupted, reduceSessionData } from "@/cli/cmd/run/session-data"

function reduce(data: ReturnType<typeof createSessionData>, event: unknown, thinking = true) {
  return reduceSessionData({
    data,
    event: event as Event,
    sessionID: "session-1",
    thinking,
    limits: {},
  })
}

function assistant(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        ...extra,
      },
    },
  }
}

describe("run session data", () => {
  test("buffers deltas until role and part kind are known", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: "hello",
      },
    }).data

    data = reduce(data, assistant("msg-1")).data

    const out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "",
          time: { end: Date.now() },
        },
      },
    })

    expect(out.commits).toEqual([
      {
        kind: "assistant",
        text: "hello",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
    ])
  })

  test("buffers whitespace-only initial assistant chunks until real content arrives", () => {
    let data = createSessionData()

    data = reduce(data, assistant("msg-1")).data
    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "",
          time: { start: Date.now() },
        },
      },
    }).data

    let out = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: " ",
      },
    })

    expect(out.commits).toEqual([])

    data = out.data
    out = reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: "Found",
      },
    })

    expect(out.commits).toEqual([
      {
        kind: "assistant",
        text: " Found",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
    ])
  })

  test("drops user text when the delayed role resolves to user", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-user-1",
          messageID: "msg-user-1",
          sessionID: "session-1",
          type: "text",
          text: "HELLO",
          time: { end: Date.now() },
        },
      },
    }).data

    const out = reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "msg-user-1",
          role: "user",
        },
      },
    })

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("txt-user-1")).toBe(true)
  })

  test("suppresses reasoning when thinking is disabled", () => {
    const out = reduce(
      createSessionData(),
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "reason-1",
            messageID: "msg-1",
            sessionID: "session-1",
            type: "reasoning",
            text: "hidden",
            time: { end: Date.now() },
          },
        },
      },
      false,
    )

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("reason-1")).toBe(true)
  })

  test("dedupes tool lifecycle events and emits output/final commits", () => {
    let data = createSessionData()

    let out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "bash-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
            },
          },
        },
      },
    })

    expect(out.commits).toHaveLength(1)
    expect(out.commits[0]).toMatchObject({
      kind: "tool",
      text: "running bash",
      phase: "start",
      source: "tool",
      messageID: "msg-1",
      partID: "bash-1",
      tool: "bash",
      toolState: "running",
    })

    data = out.data
    expect(
      reduce(data, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "bash-1",
            messageID: "msg-1",
            sessionID: "session-1",
            type: "tool",
            tool: "bash",
            state: {
              status: "running",
              input: {
                command: "git status --short",
              },
            },
          },
        },
      }).commits,
    ).toEqual([])

    out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "bash-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: {
              command: "git status --short",
            },
            output: "clean",
            time: { start: 1, end: 2 },
          },
        },
      },
    })

    expect(out.commits).toHaveLength(1)
    expect(out.commits[0]).toMatchObject({
      kind: "tool",
      text: "clean",
      phase: "progress",
      source: "tool",
      messageID: "msg-1",
      partID: "bash-1",
      tool: "bash",
      toolState: "completed",
    })

    data = out.data
    out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "write-1",
          messageID: "msg-2",
          sessionID: "session-1",
          type: "tool",
          tool: "write",
          state: {
            status: "running",
            input: {
              filePath: "src/a.ts",
            },
          },
        },
      },
    })

    expect(out.commits).toHaveLength(1)
    expect(out.commits[0]).toMatchObject({
      kind: "tool",
      text: "running write",
      phase: "start",
      source: "tool",
      messageID: "msg-2",
      partID: "write-1",
      tool: "write",
      toolState: "running",
    })

    data = out.data
    out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "write-1",
          messageID: "msg-2",
          sessionID: "session-1",
          type: "tool",
          tool: "write",
          state: {
            status: "completed",
            input: {
              filePath: "src/a.ts",
            },
            output: "ok",
            time: { start: 1, end: 2 },
          },
        },
      },
    })

    expect(out.commits).toHaveLength(1)
    expect(out.commits[0]).toMatchObject({
      kind: "tool",
      text: "",
      phase: "final",
      source: "tool",
      messageID: "msg-2",
      partID: "write-1",
      tool: "write",
      toolState: "completed",
    })
  })

  test("keeps permission precedence over queued questions", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "read",
        patterns: ["/tmp/file.txt"],
        metadata: {},
        always: [],
      },
    }).data

    const ask = reduce(data, {
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "session-1",
        questions: [
          {
            question: "Mode?",
            header: "Mode",
            options: [{ label: "chunked", description: "Incremental output" }],
            multiple: false,
          },
        ],
      },
    })

    expect(ask.footer).toEqual({
      patch: { status: "awaiting permission" },
      view: {
        type: "permission",
        request: expect.objectContaining({ id: "perm-1" }),
      },
    })

    const next = reduce(ask.data, {
      type: "permission.replied",
      properties: {
        sessionID: "session-1",
        requestID: "perm-1",
        reply: "reject",
      },
    })

    expect(next.footer).toEqual({
      patch: { status: "awaiting answer" },
      view: {
        type: "question",
        request: expect.objectContaining({ id: "question-1" }),
      },
    })
  })

  test("refreshes the active permission view when tool input arrives later", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-1",
          callID: "call-1",
        },
      },
    }).data

    const out = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-1",
          sessionID: "session-1",
          callID: "call-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
            },
          },
        },
      },
    })

    expect(out.footer).toEqual({
      view: {
        type: "permission",
        request: expect.objectContaining({
          id: "perm-1",
          metadata: expect.objectContaining({
            input: {
              command: "git status --short",
            },
          }),
        }),
      },
    })
  })

  test("strips bash echo only from the first assistant flush", () => {
    let data = createSessionData()
    data = reduce(data, assistant("msg-1")).data

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: {
              command: "printf hi",
            },
            output: "echoed\n",
            time: { start: 1, end: 2 },
          },
        },
      },
    }).data

    const first = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "echoed\nanswer",
        },
      },
    })

    expect(first.commits).toEqual([
      {
        kind: "assistant",
        text: "answer",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
    ])

    const next = reduce(first.data, {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "msg-1",
        partID: "txt-1",
        field: "text",
        delta: "\nechoed\nagain",
      },
    })

    expect(next.commits).toEqual([
      {
        kind: "assistant",
        text: "\nechoed\nagain",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
    ])
  })

  test("emits assistant error rows after replaying pending text", () => {
    let data = createSessionData()

    data = reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "hello",
          time: { end: Date.now() },
        },
      },
    }).data

    const out = reduce(
      data,
      assistant("msg-1", {
        error: {
          name: "UnknownError",
          data: {
            message: "boom",
          },
        },
      }),
    )

    expect(out.commits).toEqual([
      {
        kind: "assistant",
        text: "hello",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
      {
        kind: "error",
        text: "boom",
        phase: "start",
        source: "system",
        messageID: "msg-1",
      },
    ])
  })

  test("flushInterrupted emits interrupted finals for in-flight parts", () => {
    const data = reduce(createSessionData(), {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "unfinished",
        },
      },
    }).data

    const commits: ReturnType<typeof reduce>["commits"] = []
    flushInterrupted(data, commits)

    expect(commits).toEqual([
      {
        kind: "assistant",
        text: "unfinished",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
      },
      {
        kind: "assistant",
        text: "",
        phase: "final",
        source: "assistant",
        messageID: "msg-1",
        partID: "txt-1",
        interrupted: true,
      },
    ])
  })

  test("flushInterrupted does not emit the same interrupted final twice", () => {
    const data = reduce(createSessionData(), {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-1",
          sessionID: "session-1",
          type: "text",
          text: "unfinished",
        },
      },
    }).data

    const first: ReturnType<typeof reduce>["commits"] = []
    flushInterrupted(data, first)
    expect(first).toHaveLength(2)

    const next: ReturnType<typeof reduce>["commits"] = []
    flushInterrupted(data, next)
    expect(next).toEqual([])
  })

  test("emits session error transcript rows", () => {
    const out = reduce(createSessionData(), {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: {
          name: "UnknownError",
          data: {
            message: "permission denied",
          },
        },
      },
    })

    expect(out.commits).toEqual([
      {
        kind: "error",
        text: "permission denied",
        phase: "start",
        source: "system",
      },
    ])
  })
})
