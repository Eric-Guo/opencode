import { describe, expect, test } from "bun:test"
import * as DateTime from "effect/DateTime"
import { SessionID } from "../../src/session/schema"
import { SessionEntry } from "../../src/v2/session-entry"
import { SessionEntryStepper } from "../../src/v2/session-entry-stepper"
import { SessionEvent } from "../../src/v2/session-event"

const sessionID = SessionID.descending()
const time = (n: number) => DateTime.makeUnsafe(n)
const tokens = {
  input: 1,
  output: 2,
  reasoning: 3,
  cache: {
    read: 4,
    write: 5,
  },
}

function base<const Type extends SessionEvent.Type>(type: Type, timestamp: number) {
  return {
    id: SessionEvent.ID.create(),
    type,
    sessionID,
    timestamp: time(timestamp),
  }
}

function stepStarted(timestamp = 1) {
  return ({
    ...base("session.step.started", timestamp),
    model: {
      id: "model",
      providerID: "provider",
    },
  })
}

function stepEnded(timestamp = 1) {
  return ({
    ...base("session.step.ended", timestamp),
    reason: "stop",
    cost: 1,
    tokens,
  })
}

function assistant() {
  return new SessionEntry.Assistant({
    id: SessionEvent.ID.create(),
    type: "assistant",
    time: { created: time(0) },
    content: [],
    retries: [],
  })
}

function retryError(message: string) {
  return ({
    message,
    isRetryable: true,
  })
}

function retried(attempt: number, message: string, timestamp = 1) {
  return ({
    ...base("session.retried", timestamp),
    attempt,
    error: retryError(message),
  })
}

function retry(attempt: number, message: string, created: number) {
  return new SessionEntry.AssistantRetry({
    attempt,
    error: retryError(message),
    time: {
      created: time(created),
    },
  })
}

function memoryState() {
  const state: SessionEntryStepper.MemoryState = {
    entries: [],
    pending: [],
  }
  return state
}

function active() {
  const state: SessionEntryStepper.MemoryState = {
    entries: [assistant()],
    pending: [],
  }
  return state
}

function run(events: SessionEvent.Event[], state = memoryState()) {
  return events.reduce<SessionEntryStepper.MemoryState>((state, event) => SessionEntryStepper.step(state, event), state)
}

function last(state: SessionEntryStepper.MemoryState) {
  const entry = [...state.pending, ...state.entries].reverse().find((x) => x.type === "assistant")
  expect(entry?.type).toBe("assistant")
  return entry?.type === "assistant" ? entry : undefined
}

function textsOf(state: SessionEntryStepper.MemoryState) {
  const entry = last(state)
  if (!entry) return []
  return entry.content.filter((x): x is SessionEntry.AssistantText => x.type === "text")
}

function reasons(state: SessionEntryStepper.MemoryState) {
  const entry = last(state)
  if (!entry) return []
  return entry.content.filter((x): x is SessionEntry.AssistantReasoning => x.type === "reasoning")
}

function tools(state: SessionEntryStepper.MemoryState) {
  const entry = last(state)
  if (!entry) return []
  return entry.content.filter((x): x is SessionEntry.AssistantTool => x.type === "tool")
}

function tool(state: SessionEntryStepper.MemoryState, callID: string) {
  return tools(state).find((x) => x.callID === callID)
}

function retriesOf(state: SessionEntryStepper.MemoryState) {
  const entry = last(state)
  if (!entry) return []
  return entry.retries ?? []
}

describe("session-entry-stepper", () => {
  describe("stepWith", () => {
    test("aggregates retry events onto the current assistant", () => {
      const state = active()

      SessionEntryStepper.stepWith(SessionEntryStepper.memory(state), retried(1, "rate limited", 1))
      SessionEntryStepper.stepWith(SessionEntryStepper.memory(state), retried(2, "provider overloaded", 2))

      expect(retriesOf(state)).toEqual([retry(1, "rate limited", 1), retry(2, "provider overloaded", 2)])
    })
  })

  describe("memory", () => {
    test("tracks and replaces the current assistant", () => {
      const state = active()
      const adapter = SessionEntryStepper.memory(state)
      const current = adapter.getCurrentAssistant()

      expect(current?.type).toBe("assistant")
      if (!current) return

      adapter.updateAssistant(
        new SessionEntry.Assistant({
          ...current,
          content: [new SessionEntry.AssistantText({ type: "text", text: "done" })],
          time: {
            ...current.time,
            completed: time(1),
          },
        }),
      )

      expect(adapter.getCurrentAssistant()).toBeUndefined()
      expect(state.entries[0]?.type).toBe("assistant")
      if (state.entries[0]?.type !== "assistant") return

      expect(state.entries[0].content).toEqual([{ type: "text", text: "done" }])
      expect(state.entries[0].time.completed).toEqual(time(1))
    })

    test("appends committed and pending entries", () => {
      const state = memoryState()
      const adapter = SessionEntryStepper.memory(state)
      const committed = SessionEntry.User.fromEvent(
        ({ ...base("session.prompted", 1), prompt: { text: "committed" } }),
      )
      const pending = SessionEntry.User.fromEvent(({ ...base("session.prompted", 2), prompt: { text: "pending" } }))

      adapter.appendEntry(committed)
      adapter.appendPending(pending)

      expect(state.entries).toEqual([committed])
      expect(state.pending).toEqual([pending])
    })

    test("stepWith through memory records reasoning", () => {
      const state = active()

      SessionEntryStepper.stepWith(SessionEntryStepper.memory(state), (base("session.reasoning.started", 1)))
      SessionEntryStepper.stepWith(
        SessionEntryStepper.memory(state),
        ({ ...base("session.reasoning.delta", 2), delta: "draft" }),
      )
      SessionEntryStepper.stepWith(
        SessionEntryStepper.memory(state),
        ({ ...base("session.reasoning.ended", 3), text: "final" }),
      )

      expect(reasons(state)).toEqual([{ type: "reasoning", text: "final" }])
    })

    test("stepWith through memory records retries", () => {
      const state = active()

      SessionEntryStepper.stepWith(SessionEntryStepper.memory(state), retried(1, "rate limited", 1))

      expect(retriesOf(state)).toEqual([retry(1, "rate limited", 1)])
    })
  })

  describe("step", () => {
    describe("seeded pending assistant", () => {
      test("stores prompts in entries when no assistant is pending", () => {
        const next = SessionEntryStepper.step(memoryState(), ({ ...base("session.prompted", 1), prompt: { text: "hello" } }))
        expect(next.entries).toHaveLength(1)
        expect(next.entries[0]?.type).toBe("user")
        if (next.entries[0]?.type !== "user") return
        expect(next.entries[0].text).toBe("hello")
      })

      test("stores prompts in pending when an assistant is pending", () => {
        const next = SessionEntryStepper.step(active(), ({ ...base("session.prompted", 1), prompt: { text: "hello" } }))
        expect(next.pending).toHaveLength(1)
        expect(next.pending[0]?.type).toBe("user")
        if (next.pending[0]?.type !== "user") return
        expect(next.pending[0].text).toBe("hello")
      })

      test("accumulates text deltas on the latest text part", () => {
        const next = run(
          [
            (base("session.text.started", 1)),
            ({ ...base("session.text.delta", 2), delta: "hel" }),
            ({ ...base("session.text.delta", 3), delta: "lo" }),
          ],
          active(),
        )

        expect(textsOf(next)).toEqual([
          {
            type: "text",
            text: "hello",
          },
        ])
      })

      test("routes later text deltas to the latest text segment", () => {
        const next = run(
          [
            (base("session.text.started", 1)),
            ({ ...base("session.text.delta", 2), delta: "first" }),
            (base("session.text.started", 3)),
            ({ ...base("session.text.delta", 4), delta: "second" }),
          ],
          active(),
        )

        expect(textsOf(next)).toEqual([
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ])
      })

      test("reasoning.ended replaces buffered reasoning text", () => {
        const next = run(
          [
            (base("session.reasoning.started", 1)),
            ({ ...base("session.reasoning.delta", 2), delta: "draft" }),
            ({ ...base("session.reasoning.ended", 3), text: "final" }),
          ],
          active(),
        )

        expect(reasons(next)).toEqual([
          {
            type: "reasoning",
            text: "final",
          },
        ])
      })

      test("tool.success completes the latest running tool", () => {
        const input = { command: "ls", limit: 2 }
        const metadata = { cwd: "/tmp" }
        const attachments = [SessionEvent.FileAttachment.create({ uri: "file:///tmp/out.txt", mime: "text/plain" })]
        const next = run(
          [
            ({ ...base("session.tool.input.started", 1), callID: "call", name: "bash" }),
            ({ ...base("session.tool.input.delta", 2), callID: "call", delta: "{\"command\":" }),
            ({ ...base("session.tool.input.delta", 3), callID: "call", delta: "\"ls\"}" }),
            ({
              ...base("session.tool.called", 4),
              callID: "call",
              tool: "bash",
              input,
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.success", 5),
              callID: "call",
              title: "Listed files",
              output: "ok",
              metadata,
              attachments,
              provider: { executed: true },
            }),
          ],
          active(),
        )

        const match = tool(next, "call")
        expect(match?.state.status).toBe("completed")
        if (match?.state.status !== "completed") return

        expect(match.time.ran).toEqual(time(4))
        expect(match.state.input).toEqual(input)
        expect(match.state.output).toBe("ok")
        expect(match.state.title).toBe("Listed files")
        expect(match.state.metadata).toEqual(metadata)
        expect(match.state.attachments).toEqual(attachments)
      })

      test("tool.error completes the latest running tool with an error", () => {
        const input = { command: "ls" }
        const metadata = { cwd: "/tmp" }
        const next = run(
          [
            ({ ...base("session.tool.input.started", 1), callID: "call", name: "bash" }),
            ({
              ...base("session.tool.called", 2),
              callID: "call",
              tool: "bash",
              input,
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.error", 3),
              callID: "call",
              error: "permission denied",
              metadata,
              provider: { executed: true },
            }),
          ],
          active(),
        )

        const match = tool(next, "call")
        expect(match?.state.status).toBe("error")
        if (match?.state.status !== "error") return

        expect(match.time.ran).toEqual(time(2))
        expect(match.state.input).toEqual(input)
        expect(match.state.error).toBe("permission denied")
        expect(match.state.metadata).toEqual(metadata)
      })

      test("tool.success is ignored before tool.called promotes the tool to running", () => {
        const next = run(
          [
            ({ ...base("session.tool.input.started", 1), callID: "call", name: "bash" }),
            ({
              ...base("session.tool.success", 2),
              callID: "call",
              title: "Done",
              provider: { executed: true },
            }),
          ],
          active(),
        )
        const match = tool(next, "call")
        expect(match?.state).toEqual({
          status: "pending",
          input: "",
        })
      })

      test("step.ended copies completion fields onto the pending assistant", () => {
        const event = stepEnded(9)
        const next = SessionEntryStepper.step(active(), event)
        const entry = last(next)
        expect(entry).toBeDefined()
        if (!entry) return

        expect(entry.time.completed).toEqual(event.timestamp)
        expect(entry.cost).toBe(event.cost)
        expect(entry.tokens).toEqual(event.tokens)
      })
    })

    describe("known reducer gaps", () => {
      test("prompt appends immutably when no assistant is pending", () => {
        const old = memoryState()
        const next = SessionEntryStepper.step(old, ({ ...base("session.prompted", 1), prompt: { text: "hello" } }))
        expect(old).not.toBe(next)
        expect(old.entries).toHaveLength(0)
        expect(next.entries).toHaveLength(1)
      })

      test("prompt appends immutably when an assistant is pending", () => {
        const old = active()
        const next = SessionEntryStepper.step(old, ({ ...base("session.prompted", 1), prompt: { text: "hello" } }))
        expect(old).not.toBe(next)
        expect(old.pending).toHaveLength(0)
        expect(next.pending).toHaveLength(1)
      })

      test("step.started creates an assistant consumed by follow-up events", () => {
        const next = run([
          stepStarted(1),
          (base("session.text.started", 2)),
          ({ ...base("session.text.delta", 3), delta: "hello" }),
          stepEnded(4),
        ])
        const entry = last(next)

        expect(entry).toBeDefined()
        if (!entry) return

        expect(entry.content).toEqual([
          {
            type: "text",
            text: "hello",
          },
        ])
        expect(entry.time.completed).toEqual(time(4))
      })

      test("replays prompt -> step -> text -> step.ended", () => {
        const next = run([
          ({ ...base("session.prompted", 0), prompt: { text: "hello" } }),
          stepStarted(1),
          (base("session.text.started", 2)),
          ({ ...base("session.text.delta", 3), delta: "world" }),
          stepEnded(4),
        ])

        expect(next.entries).toHaveLength(2)
        expect(next.entries[0]?.type).toBe("user")
        expect(next.entries[1]?.type).toBe("assistant")
        if (next.entries[1]?.type !== "assistant") return

        expect(next.entries[1].content).toEqual([
          {
            type: "text",
            text: "world",
          },
        ])
        expect(next.entries[1].time.completed).toEqual(time(4))
      })

      test("replays prompt -> step -> reasoning -> tool -> success -> step.ended", () => {
        const input = { command: "ls" }
        const next = run([
          ({ ...base("session.prompted", 0), prompt: { text: "hello" } }),
          stepStarted(1),
          (base("session.reasoning.started", 2)),
          ({ ...base("session.reasoning.delta", 3), delta: "draft" }),
          ({ ...base("session.reasoning.ended", 4), text: "final" }),
          ({ ...base("session.tool.input.started", 5), callID: "call", name: "bash" }),
          ({
            ...base("session.tool.called", 6),
            callID: "call",
            tool: "bash",
            input,
            provider: { executed: true },
          }),
          ({
            ...base("session.tool.success", 7),
            callID: "call",
            title: "Listed files",
            output: "ok",
            provider: { executed: true },
          }),
          stepEnded(8),
        ])

        expect(next.entries.at(-1)?.type).toBe("assistant")
        const entry = next.entries.at(-1)
        if (entry?.type !== "assistant") return

        expect(entry.content).toHaveLength(2)
        expect(entry.content[0]).toEqual({
          type: "reasoning",
          text: "final",
        })
        expect(entry.content[1]?.type).toBe("tool")
        if (entry.content[1]?.type !== "tool") return
        expect(entry.content[1].state.status).toBe("completed")
        expect(entry.time.completed).toEqual(time(8))
      })

      test("starting a new step completes the old assistant and appends a new active assistant", () => {
        const next = run([stepStarted(1)], active())
        expect(next.entries).toHaveLength(2)
        expect(next.entries[0]?.type).toBe("assistant")
        expect(next.entries[1]?.type).toBe("assistant")
        if (next.entries[0]?.type !== "assistant" || next.entries[1]?.type !== "assistant") return

        expect(next.entries[0].time.completed).toEqual(time(1))
        expect(next.entries[1].time.created).toEqual(time(1))
        expect(next.entries[1].time.completed).toBeUndefined()
      })

      test("handles sequential tools independently", () => {
        const firstInput = { command: "ls" }
        const secondInput = { pattern: "TODO" }
        const next = run(
          [
            ({ ...base("session.tool.input.started", 1), callID: "a", name: "bash" }),
            ({
              ...base("session.tool.called", 2),
              callID: "a",
              tool: "bash",
              input: firstInput,
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.success", 3),
              callID: "a",
              title: "Listed",
              output: "done",
              provider: { executed: true },
            }),
            ({ ...base("session.tool.input.started", 4), callID: "b", name: "bash" }),
            ({
              ...base("session.tool.called", 5),
              callID: "b",
              tool: "bash",
              input: secondInput,
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.error", 6),
              callID: "b",
              error: "not found",
              provider: { executed: true },
            }),
          ],
          active(),
        )

        const first = tool(next, "a")
        const second = tool(next, "b")

        expect(first?.state.status).toBe("completed")
        if (first?.state.status !== "completed") return
        expect(first.state.input).toEqual(firstInput)
        expect(first.state.output).toBe("done")
        expect(first.state.title).toBe("Listed")

        expect(second?.state.status).toBe("error")
        if (second?.state.status !== "error") return
        expect(second.state.input).toEqual(secondInput)
        expect(second.state.error).toBe("not found")
      })

      test("routes tool events by callID when tool streams interleave", () => {
        const firstInput = { command: "ls" }
        const secondInput = { pattern: "TODO" }
        const next = run(
          [
            ({ ...base("session.tool.input.started", 1), callID: "a", name: "bash" }),
            ({ ...base("session.tool.input.started", 2), callID: "b", name: "grep" }),
            ({ ...base("session.tool.input.delta", 3), callID: "a", delta: "first" }),
            ({ ...base("session.tool.input.delta", 4), callID: "b", delta: "second" }),
            ({
              ...base("session.tool.called", 5),
              callID: "a",
              tool: "bash",
              input: firstInput,
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.called", 6),
              callID: "b",
              tool: "grep",
              input: secondInput,
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.success", 7),
              callID: "a",
              title: "Listed",
              output: "done-a",
              provider: { executed: true },
            }),
            ({
              ...base("session.tool.success", 8),
              callID: "b",
              title: "Grep",
              output: "done-b",
              provider: { executed: true },
            }),
          ],
          active(),
        )

        const first = tool(next, "a")
        const second = tool(next, "b")

        expect(first?.state.status).toBe("completed")
        expect(second?.state.status).toBe("completed")
        if (first?.state.status !== "completed" || second?.state.status !== "completed") return

        expect(first.state.input).toEqual(firstInput)
        expect(second.state.input).toEqual(secondInput)
        expect(first.state.title).toBe("Listed")
        expect(second.state.title).toBe("Grep")
      })

      test("records synthetic events", () => {
        const next = SessionEntryStepper.step(
          memoryState(),
          ({ ...base("session.synthetic", 1), text: "generated" }),
        )
        expect(next.entries).toHaveLength(1)
        expect(next.entries[0]?.type).toBe("synthetic")
        if (next.entries[0]?.type !== "synthetic") return
        expect(next.entries[0].text).toBe("generated")
      })

      test("records compaction events", () => {
        const next = SessionEntryStepper.step(
          memoryState(),
          ({ ...base("session.compacted", 1), auto: true, overflow: false }),
        )
        expect(next.entries).toHaveLength(1)
        expect(next.entries[0]?.type).toBe("compaction")
        if (next.entries[0]?.type !== "compaction") return
        expect(next.entries[0].auto).toBe(true)
        expect(next.entries[0].overflow).toBe(false)
      })
    })
  })
})
