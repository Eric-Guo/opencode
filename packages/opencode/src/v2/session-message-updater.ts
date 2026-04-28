import { produce, type WritableDraft } from "immer"
import { SessionEvent } from "./session-event"
import { SessionMessage } from "./session-message"

export type MemoryState = {
  messages: SessionMessage.Message[]
  pending: SessionMessage.Message[]
}

export interface Adapter<Result> {
  readonly getCurrentAssistant: () => SessionMessage.Assistant | undefined
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => void
  readonly appendMessage: (message: SessionMessage.Message) => void
  readonly appendPending: (message: SessionMessage.Message) => void
  readonly finish: () => Result
}

export function memory(state: MemoryState): Adapter<MemoryState> {
  const activeAssistantIndex = () =>
    state.messages.findLastIndex((message) => message.type === "assistant" && !message.time.completed)

  return {
    getCurrentAssistant() {
      const index = activeAssistantIndex()
      if (index < 0) return
      const assistant = state.messages[index]
      return assistant?.type === "assistant" ? assistant : undefined
    },
    updateAssistant(assistant) {
      const index = activeAssistantIndex()
      if (index < 0) return
      const current = state.messages[index]
      if (current?.type !== "assistant") return
      state.messages[index] = assistant
    },
    appendMessage(message) {
      state.messages.push(message)
    },
    appendPending(message) {
      state.pending.push(message)
    },
    finish() {
      return state
    },
  }
}

export function update<Result>(adapter: Adapter<Result>, event: SessionEvent.Event): Result {
  const currentAssistant = adapter.getCurrentAssistant()
  type DraftAssistant = WritableDraft<SessionMessage.Assistant>
  type DraftTool = WritableDraft<SessionMessage.AssistantTool>
  type DraftText = WritableDraft<SessionMessage.AssistantText>
  type DraftReasoning = WritableDraft<SessionMessage.AssistantReasoning>

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
      const message = SessionMessage.User.fromEvent(event)
      if (currentAssistant) {
        adapter.appendPending(message)
        return
      }
      adapter.appendMessage(message)
    },
    "session.next.synthetic": (event) => {
      adapter.appendMessage(SessionMessage.Synthetic.fromEvent(event))
    },
    "session.next.step.started": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.time.completed = event.data.timestamp
          }),
        )
      }
      adapter.appendMessage(SessionMessage.Assistant.fromEvent(event))
    },
    "session.next.step.ended": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            draft.time.completed = event.data.timestamp
            draft.cost = event.data.cost
            draft.tokens = event.data.tokens
            if (event.data.snapshot) draft.snapshot = { ...draft.snapshot, end: event.data.snapshot }
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
    "session.next.text.ended": (event) => {
      if (currentAssistant) {
        adapter.updateAssistant(
          produce(currentAssistant, (draft) => {
            const match = latestText(draft)
            if (match) match.text = event.data.text
          }),
        )
      }
    },
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
                structured: {},
                content: [],
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
            if (match && match.state.status === "running") {
              match.state.structured = event.data.structured
              match.state.content = [...event.data.content]
            }
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
                structured: event.data.structured,
                content: [...event.data.content],
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
                structured: match.state.structured,
                content: match.state.content,
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
    "session.next.retried": () => {},
    "session.next.compacted": (event) => {
      adapter.appendMessage(SessionMessage.Compaction.fromEvent(event))
    },
  })

  return adapter.finish()
}

export * as SessionMessageUpdater from "./session-message-updater"
