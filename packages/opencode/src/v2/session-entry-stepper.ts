import { produce, type WritableDraft } from "immer"
import { SessionEvent } from "./session-event"
import { SessionEntry } from "./session-entry"

export type MemoryState = {
  entries: SessionEntry.Entry[]
  pending: SessionEntry.Entry[]
}

export interface Adapter<Result> {
  readonly getCurrentAssistant: () => SessionEntry.Assistant | undefined
  readonly updateAssistant: (assistant: SessionEntry.Assistant) => void
  readonly appendEntry: (entry: SessionEntry.Entry) => void
  readonly appendPending: (entry: SessionEntry.Entry) => void
  readonly finish: () => Result
}

export function memory(state: MemoryState): Adapter<MemoryState> {
  const activeAssistantIndex = () =>
    state.entries.findLastIndex((entry) => entry.type === "assistant" && !entry.time.completed)

  return {
    getCurrentAssistant() {
      const index = activeAssistantIndex()
      if (index < 0) return
      const assistant = state.entries[index]
      return assistant?.type === "assistant" ? assistant : undefined
    },
    updateAssistant(assistant) {
      const index = activeAssistantIndex()
      if (index < 0) return
      const current = state.entries[index]
      if (current?.type !== "assistant") return
      state.entries[index] = assistant
    },
    appendEntry(entry) {
      state.entries.push(entry)
    },
    appendPending(entry) {
      state.pending.push(entry)
    },
    finish() {
      return state
    },
  }
}

export function stepWith<Result>(adapter: Adapter<Result>, event: SessionEvent.Event): Result {
  const currentAssistant = adapter.getCurrentAssistant()
  type DraftAssistant = WritableDraft<SessionEntry.Assistant>
  type DraftTool = WritableDraft<SessionEntry.AssistantTool>
  type DraftText = WritableDraft<SessionEntry.AssistantText>
  type DraftReasoning = WritableDraft<SessionEntry.AssistantReasoning>

  const latestTool = (assistant: DraftAssistant | undefined, callID?: string) =>
    assistant?.content.findLast(
      (item): item is DraftTool => item.type === "tool" && (callID === undefined || item.callID === callID),
    )

  const latestText = (assistant: DraftAssistant | undefined) =>
    assistant?.content.findLast((item): item is DraftText => item.type === "text")

  const latestReasoning = (assistant: DraftAssistant | undefined, reasoningID: string) =>
    assistant?.content.findLast(
      (item): item is DraftReasoning => item.type === "reasoning" && item.reasoningID === reasoningID,
    )

  SessionEvent.All.match(event, {
    "session.next.prompted": (event) => {
      const entry = SessionEntry.User.fromEvent(event)
      if (currentAssistant) {
        adapter.appendPending(entry)
        return
      }
      adapter.appendEntry(entry)
    },
    "session.next.synthetic": (event) => {
      adapter.appendEntry(SessionEntry.Synthetic.fromEvent(event))
    },
    "session.next.step.started": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.time.completed = event.data.timestamp
          }),
        )
      }
      adapter.appendEntry(SessionEntry.Assistant.fromEvent(event))
    },
    "session.next.step.ended": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.time.completed = event.data.timestamp
            draft.cost = event.data.cost
            draft.tokens = event.data.tokens
          }),
        )
      }
    },
    "session.next.text.started": () => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.content.push({
              type: "text",
              text: "",
            })
          }),
        )
      }
    },
    "session.next.text.delta": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestText(draft)
            if (match) match.text += event.data.delta
          }),
        )
      }
    },
    "session.next.text.ended": () => {},
    "session.next.tool.input.started": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.content.push({
              type: "tool",
              callID: event.data.callID,
              name: event.data.name,
              time: {
                created: event.data.timestamp,
              },
              state: {
                status: "pending",
                input: "",
              },
            })
          }),
        )
      }
    },
    "session.next.tool.input.delta": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestTool(draft, event.data.callID)
            // oxlint-disable-next-line no-base-to-string -- event.delta is a Schema.String (runtime string)
            if (match && match.state.status === "pending") match.state.input += event.data.delta
          }),
        )
      }
    },
    "session.next.tool.input.ended": () => {},
    "session.next.tool.called": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestTool(draft, event.data.callID)
            if (match) {
              match.time.ran = event.data.timestamp
              match.state = {
                status: "running",
                input: event.data.input,
              }
            }
          }),
        )
      }
    },
    "session.next.tool.progress": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestTool(draft, event.data.callID)
            if (match && match.state.status === "running") match.state.details = event.data.details
          }),
        )
      }
    },
    "session.next.tool.success": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestTool(draft, event.data.callID)
            if (match && match.state.status === "running") {
              match.state = {
                status: "completed",
                input: match.state.input,
                output: event.data.output ?? "",
                details: event.data.details,
                attachments: [...(event.data.attachments ?? [])],
              }
            }
          }),
        )
      }
    },
    "session.next.tool.error": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestTool(draft, event.data.callID)
            if (match && match.state.status === "running") {
              match.state = {
                status: "error",
                error: event.data.error,
                input: match.state.input,
              }
            }
          }),
        )
      }
    },
    "session.next.reasoning.started": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.content.push({
              type: "reasoning",
              reasoningID: event.data.reasoningID,
              text: "",
            })
          }),
        )
      }
    },
    "session.next.reasoning.delta": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestReasoning(draft, event.data.reasoningID)
            if (match) match.text += event.data.delta
          }),
        )
      }
    },
    "session.next.reasoning.ended": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestReasoning(draft, event.data.reasoningID)
            if (match) match.text = event.data.text
          }),
        )
      }
    },
    "session.next.retried": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.retries = [...(draft.retries ?? []), SessionEntry.AssistantRetry.fromEvent(event)]
          }),
        )
      }
    },
    "session.next.compacted": (event) => {
      adapter.appendEntry(SessionEntry.Compaction.fromEvent(event))
    },
  })

  return adapter.finish()
}

export function step(old: MemoryState, event: SessionEvent.Event): MemoryState {
  return produce(old, (draft) => {
    stepWith(memory(draft as MemoryState), event)
  })
}

export * as SessionEntryStepper from "./session-entry-stepper"
