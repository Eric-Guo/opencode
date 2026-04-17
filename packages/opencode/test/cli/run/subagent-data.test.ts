import { describe, expect, test } from "bun:test"
import { normalizeEntry } from "../../../src/cli/cmd/run/scrollback.format"
import {
  bootstrapSubagentData,
  clearFinishedSubagents,
  createSubagentData,
  reduceSubagentData,
  snapshotSelectedSubagentData,
  snapshotSubagentData,
} from "../../../src/cli/cmd/run/subagent-data"

function taskMessage(sessionID: string, status: "running" | "completed" | "error" = "completed") {
  return {
    info: {
      id: `msg-${sessionID}`,
      role: "assistant",
    },
    parts: [
      {
        id: `part-${sessionID}`,
        sessionID: "parent-1",
        messageID: `msg-${sessionID}`,
        type: "tool",
        callID: `call-${sessionID}`,
        tool: "task",
        state: {
          status,
          input: {
            description: "Scan reducer paths",
            subagent_type: "explore",
          },
          title: "Reducer touchpoints",
          metadata: {
            sessionId: sessionID,
            toolcalls: 4,
          },
          time: status === "running" ? { start: 1 } : { start: 1, end: 2 },
        },
      },
    ],
  } as const
}

function question(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Mode?",
        header: "Mode",
        options: [{ label: "Fast", description: "Quick pass" }],
      },
    ],
  }
}

describe("run subagent data", () => {
  test("bootstraps tabs and child blockers from parent task parts", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentData({
        data,
        messages: [taskMessage("child-1") as never],
        children: [{ id: "child-1" }, { id: "child-2" }],
        permissions: [
          {
            id: "perm-1",
            sessionID: "child-1",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
          {
            id: "perm-2",
            sessionID: "other",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
        ],
        questions: [question("question-1", "child-1"), question("question-2", "other")],
      }),
    ).toBe(true)

    expect(snapshotSubagentData(data)).toEqual({
      tabs: [
        expect.objectContaining({
          sessionID: "child-1",
          label: "Explore",
          description: "Scan reducer paths",
          title: "Reducer touchpoints",
          status: "completed",
          toolCalls: 4,
        }),
      ],
      details: {
        "child-1": {
          sessionID: "child-1",
          commits: [],
        },
      },
      permissions: [expect.objectContaining({ id: "perm-1", sessionID: "child-1" })],
      questions: [expect.objectContaining({ id: "question-1", sessionID: "child-1" })],
    })
  })

  test("reduces child text tool and blocker events into footer detail state", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running") as never],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-1",
            messageID: "msg-user-1",
            sessionID: "child-1",
            type: "text",
            text: "Inspect footer tabs",
          },
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.updated",
        properties: {
          sessionID: "child-1",
          info: {
            id: "msg-user-1",
            role: "user",
          },
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.updated",
        properties: {
          sessionID: "child-1",
          info: {
            id: "msg-assistant-1",
            role: "assistant",
          },
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "reason-1",
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            type: "reasoning",
            text: "planning next steps",
            time: { start: 1 },
          },
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "running",
              input: {
                command: "git status --short",
              },
              time: { start: 1 },
            },
          },
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-1",
          sessionID: "child-1",
          permission: "bash",
          patterns: ["git status --short"],
          metadata: {},
          always: [],
          tool: {
            messageID: "msg-assistant-1",
            callID: "call-1",
          },
        },
      } as never,
    })

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
    expect(snapshot.details["child-1"]).toEqual({
      sessionID: "child-1",
      commits: expect.any(Array),
    })
    expect(snapshot.details["child-1"]?.commits.map((item) => normalizeEntry(item))).toEqual([
      "› Inspect footer tabs",
      "Thinking: planning next steps",
      "# Shell\n$ git status --short",
    ])
    expect(snapshot.permissions).toEqual([
      expect.objectContaining({
        id: "perm-1",
        metadata: {
          input: {
            command: "git status --short",
          },
        },
      }),
    ])
    expect(snapshot.questions).toEqual([])
  })

  test("continues live child text streams", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running") as never],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.updated",
        properties: {
          sessionID: "child-1",
          info: {
            id: "msg-assistant-1",
            role: "assistant",
          },
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-1",
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            type: "text",
            text: "hello",
          },
        },
      } as never,
    })

    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "child-1",
          messageID: "msg-assistant-1",
          partID: "txt-1",
          field: "text",
          delta: " world",
        },
      } as never,
    })
    reduceSubagentData({
      data,
      sessionID: "parent-1",
      thinking: true,
      limits: {},
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "txt-1",
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            type: "text",
            text: "hello world",
            time: { start: 1, end: 2 },
          },
        },
      } as never,
    })

    expect(
      snapshotSelectedSubagentData(data, "child-1").details["child-1"]?.commits.map((item) => normalizeEntry(item)),
    ).toEqual(["hello world"])
  })

  test("clears finished tabs on the next parent prompt", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "completed") as never, taskMessage("child-2", "running") as never],
      children: [{ id: "child-1" }, { id: "child-2" }],
      permissions: [],
      questions: [],
    })

    expect(clearFinishedSubagents(data)).toBe(true)
    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-2", status: "running" }),
    ])
  })
})
