// Shared type vocabulary for the direct interactive mode (`run --interactive`).
//
// Direct mode uses a split-footer terminal layout: immutable scrollback for the
// session transcript, and a mutable footer for prompt input, status, and
// permission/question UI. Every module in run/* shares these types to stay
// aligned on that two-lane model.
//
// Data flow through the system:
//
//   SDK events → session-data reducer → StreamCommit[] + FooterOutput
//     → stream.ts bridges to footer API
//       → footer.ts queues commits and patches the footer view
//         → OpenTUI split-footer renderer writes to terminal
import type { OpencodeClient, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"

export type RunFilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type PromptModel = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]
type PromptInput = Parameters<OpencodeClient["session"]["prompt"]>[0]

export type RunPromptPart = NonNullable<PromptInput["parts"]>[number]

export type RunPrompt = {
  text: string
  parts: RunPromptPart[]
}

export type RunAgent = NonNullable<Awaited<ReturnType<OpencodeClient["app"]["agents"]>>["data"]>[number]

type RunResourceMap = NonNullable<Awaited<ReturnType<OpencodeClient["experimental"]["resource"]["list"]>>["data"]>

export type RunResource = RunResourceMap[string]

export type RunInput = {
  sdk: OpencodeClient
  directory: string
  sessionID: string
  sessionTitle?: string
  resume?: boolean
  agent: string | undefined
  model: PromptModel | undefined
  variant: string | undefined
  files: RunFilePart[]
  initialInput?: string
  thinking: boolean
  demo?: RunDemo
  demoText?: string
}

export type RunDemo = "on" | "permission" | "question" | "mix" | "text"

// The semantic role of a scrollback entry. Maps 1:1 to theme colors.
export type EntryKind = "system" | "user" | "assistant" | "reasoning" | "tool" | "error"

// Whether the assistant is actively processing a turn.
export type FooterPhase = "idle" | "running"

// Full snapshot of footer status bar state. Every update replaces the whole
// object in the SolidJS signal so the view re-renders atomically.
export type FooterState = {
  phase: FooterPhase
  status: string
  queue: number
  model: string
  duration: string
  usage: string
  first: boolean
  interrupt: number
  exit: number
}

// A partial update to FooterState. The footer merges this onto the current state.
export type FooterPatch = Partial<FooterState>

export type RunDiffStyle = "auto" | "stacked"

export type ScrollbackOptions = {
  diffStyle?: RunDiffStyle
}

// Which interactive surface the footer is showing. Only one view is active at
// a time. The reducer drives transitions: when a permission arrives the view
// switches to "permission", and when the permission resolves it falls back to
// "prompt".
export type FooterView =
  | { type: "prompt" }
  | { type: "permission"; request: PermissionRequest }
  | { type: "question"; request: QuestionRequest }

// The reducer emits this alongside scrollback commits so the footer can update in the same frame.
export type FooterOutput = {
  patch?: FooterPatch
  view?: FooterView
}

// Typed messages sent to RunFooter.event(). The prompt queue and stream
// transport both emit these to update footer state without reaching into
// internal signals directly.
export type FooterEvent =
  | {
      type: "queue"
      queue: number
    }
  | {
      type: "first"
      first: boolean
    }
  | {
      type: "model"
      model: string
    }
  | {
      type: "turn.send"
      queue: number
    }
  | {
      type: "turn.wait"
    }
  | {
      type: "turn.idle"
      queue: number
    }
  | {
      type: "turn.duration"
      duration: string
    }
  | {
      type: "stream.patch"
      patch: FooterPatch
    }
  | {
      type: "stream.view"
      view: FooterView
    }

export type PermissionReply = Parameters<OpencodeClient["permission"]["reply"]>[0]

export type QuestionReply = Parameters<OpencodeClient["question"]["reply"]>[0]

export type QuestionReject = Parameters<OpencodeClient["question"]["reject"]>[0]

export type FooterKeybinds = {
  leader: string
  variantCycle: string
  interrupt: string
  historyPrevious: string
  historyNext: string
  inputSubmit: string
  inputNewline: string
}

// Lifecycle phase of a scrollback entry. "start" opens the entry, "progress"
// appends content (coalesced in the footer queue), "final" closes it.
export type StreamPhase = "start" | "progress" | "final"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamToolState = "running" | "completed" | "error"

// A single append-only commit to scrollback. The session-data reducer produces
// these from SDK events, and RunFooter.append() queues them for the next
// microtask flush. Once flushed, they become immutable terminal scrollback
// rows -- they cannot be rewritten.
export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  source: StreamSource
  messageID?: string
  partID?: string
  tool?: string
  part?: ToolPart
  interrupted?: boolean
  toolState?: StreamToolState
  toolError?: string
}

// The public contract between the stream transport / prompt queue and
// the footer. RunFooter implements this. The transport and queue never
// touch the renderer directly -- they go through this interface.
export type FooterApi = {
  readonly isClosed: boolean
  onPrompt(fn: (input: RunPrompt) => void): () => void
  onClose(fn: () => void): () => void
  event(next: FooterEvent): void
  append(commit: StreamCommit): void
  idle(): Promise<void>
  close(): void
  destroy(): void
}
