import type {
  AgentPart,
  ComposerStore,
  FileAttachmentPart,
  ImageAttachmentPart,
  PathAttachmentPart,
  Prompt,
  SkillPart,
  SessionPart,
} from "./schema"

export type {
  AgentPart,
  ComposerStore,
  ContentPart,
  ContextItem,
  FileAttachmentPart,
  FileContextItem,
  ImageAttachmentPart,
  NoteComment,
  NoteContextItem,
  PathAttachmentPart,
  Prompt,
  PromptModel,
  QuoteComment,
  QuoteContextItem,
  SessionPart,
  SkillPart,
  TextPart,
} from "./schema"
export type { FileSelection } from "../workspaces/files/types"
export type { PromptScope } from "./state"

export type FilePartSource = NonNullable<FileAttachmentPart["source"]>

export type ComposerFilePart = FileAttachmentPart

export type ComposerAgentPart = AgentPart

export type ComposerSkillPart = SkillPart

export type ComposerSessionPart = SessionPart

export type ComposerAttachment = ImageAttachmentPart | PathAttachmentPart

export type ComposerPrompt = Prompt

export type ComposerComment = ComposerStore["context"]["items"][number]

export type ComposerPersistedState = ComposerStore

export type ComposerHistoryEntry = {
  prompt: ComposerPrompt
  metadata?: unknown
}

export type ComposerHistory = {
  entries: (mode: "normal" | "shell") => ComposerHistoryEntry[]
  add: (prompt: ComposerPrompt, mode: "normal" | "shell") => void
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the editor carries host-owned history metadata without interpreting it
  capture?: () => unknown
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- restore receives the same opaque value supplied by this host's capture or entries
  restore?: (metadata: unknown) => void
}

export type ComposerCapabilities = {
  commands?: boolean
  context?: boolean
  shell?: boolean
}

export type ComposerOption = {
  id: string
  label: string
  providerID?: string
}

export type ComposerSuggestion = {
  id: string
  kind: "agent" | "command" | "file" | "reference" | "resource" | "skill" | "session" | "history"
  label: string
  title?: string
  trigger?: string
  description?: string
  path?: string
  keybind?: string[]
  recent?: boolean
  history?: ComposerHistoryEntry
  mention?: ComposerFilePart | ComposerAgentPart | ComposerSkillPart | ComposerSessionPart
}
