import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show, mapArray, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Accordion } from "@opencode-ai/ui/accordion"
import { Button } from "@opencode-ai/ui/button"
import { Card } from "@opencode-ai/ui/card"
import {
  ContextToolGroup,
  groupParts,
  Message,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  renderable,
  type PartGroup,
  type UserActions,
} from "@opencode-ai/ui/message-part"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Spinner } from "@opencode-ai/ui/spinner"
import { SessionRetry } from "@opencode-ai/ui/session-retry"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { TextField } from "@opencode-ai/ui/text-field"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  SnapshotFileDiff,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { normalize } from "@opencode-ai/ui/session-diff"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { makeTimer } from "@solid-primitives/timer"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type SummaryDiff = SnapshotFileDiff & { file: string }

type TimelineRow =
  | { key: string; type: "comment-strip"; userMessageID: string; previousUserMessage: boolean }
  | { key: string; type: "user-message"; userMessageID: string; anchor: boolean; previousUserMessage: boolean }
  | { key: string; type: "turn-divider"; userMessageID: string; label: "compaction" | "interrupted" }
  | {
      key: string
      type: "assistant-part"
      userMessageID: string
      group: PartGroup
      previousAssistantPart: boolean
      lastAssistantPart: boolean
    }
  | { key: string; type: "thinking"; userMessageID: string; reasoningHeading?: string }
  | { key: string; type: "retry"; userMessageID: string }
  | { key: string; type: "diff-summary"; userMessageID: string; diffs: SummaryDiff[] }
  | { key: string; type: "error"; userMessageID: string; text: string }
  | { key: string; type: "bottom-spacer" }

type FramedTimelineRow = Exclude<TimelineRow, { type: "bottom-spacer" }>

function sameKeys(a: readonly string[] | undefined, b: readonly string[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((key, index) => key === b[index])
}

const timelineCacheLimit = 16
const timelineCache = new Map<string, { keys: readonly string[]; cache: VirtualizerHandle["cache"] }>()

function readTimelineCache(id: string, keys: readonly string[]) {
  const entry = timelineCache.get(id)
  if (!entry) return
  if (sameKeys(entry.keys, keys)) return entry.cache
  timelineCache.delete(id)
}

function writeTimelineCache(id: string, keys: readonly string[], handle: VirtualizerHandle | undefined) {
  if (!handle || keys.length === 0) return
  timelineCache.delete(id)
  timelineCache.set(id, { keys: keys.slice(), cache: handle.cache })
  while (timelineCache.size > timelineCacheLimit) timelineCache.delete(timelineCache.keys().next().value!)
}

function samePartGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return a.ref.messageID === b.ref.messageID && a.ref.partID === b.ref.partID
  }
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, index) => ref.messageID === b.refs[index]?.messageID && ref.partID === b.refs[index]?.partID)
}

function sameSummaryDiff(a: SummaryDiff, b: SummaryDiff) {
  return a.file === b.file && a.patch === b.patch && a.additions === b.additions && a.deletions === b.deletions && a.status === b.status
}

function sameSummaryDiffs(a: readonly SummaryDiff[], b: readonly SummaryDiff[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((diff, index) => sameSummaryDiff(diff, b[index]!))
}

function sameTimelineRow(a: TimelineRow, b: TimelineRow) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "bottom-spacer") return b.type === "bottom-spacer"
  if (b.type === "bottom-spacer") return false
  if (a.userMessageID !== b.userMessageID) return false

  switch (a.type) {
    case "comment-strip":
      return b.type === "comment-strip" && a.previousUserMessage === b.previousUserMessage
    case "user-message":
      return b.type === "user-message" && a.anchor === b.anchor && a.previousUserMessage === b.previousUserMessage
    case "turn-divider":
      return b.type === "turn-divider" && a.label === b.label
    case "assistant-part":
      return (
        b.type === "assistant-part" &&
        a.previousAssistantPart === b.previousAssistantPart &&
        a.lastAssistantPart === b.lastAssistantPart &&
        samePartGroup(a.group, b.group)
      )
    case "thinking":
      return b.type === "thinking" && a.reasoningHeading === b.reasoningHeading
    case "retry":
      return b.type === "retry"
    case "diff-summary":
      return b.type === "diff-summary" && sameSummaryDiffs(a.diffs, b.diffs)
    case "error":
      return b.type === "error" && a.text === b.text
  }
}

function reuseTimelineRows(previous: TimelineRow[] | undefined, rows: TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [row.key, row] as const))
  return rows.map((row) => {
    const existing = byKey.get(row.key)
    if (!existing) return row
    return sameTimelineRow(existing, row) ? existing : row
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrapErrorMessage(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function cleanHeading(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
}

function reasoningHeading(text: string) {
  const markdown = text.replace(/\r\n?/g, "\n")
  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  if (html?.[1]) {
    const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
    if (value) return value
  }

  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
  if (atx?.[1]) {
    const value = cleanHeading(atx[1])
    if (value) return value
  }

  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
  if (setext?.[1]) {
    const value = cleanHeading(setext[1])
    if (value) return value
  }

  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
  if (strong?.[1]) {
    const value = cleanHeading(strong[1])
    if (value) return value
  }
}

function summaryDiff(value: SnapshotFileDiff): value is SummaryDiff {
  return typeof value.file === "string"
}

const messageComments = (parts: PartType[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const pace = (width: number) => Math.round(Math.max(1200, Math.min(3200, (Math.max(width, 360) * 2000) / 900)))

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

function TimelineThinkingRow(props: { reasoningHeading?: string; showReasoningSummaries: boolean }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={language.t("ui.sessionTurn.status.thinking")} />
      <Show when={!props.showReasoningSummaries}>
        <TextReveal
          text={props.reasoningHeading}
          class="session-turn-thinking-heading"
          travel={25}
          duration={700}
        />
      </Show>
    </div>
  )
}

function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[] }) {
  const language = useLanguage()
  const fileComponent = useFileComponent()
  const maxFiles = 10
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  return (
    <div data-slot="session-turn-diffs" data-component="session-turn-diffs-group" data-show-all={showAll() || undefined}>
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {props.diffs.length} {language.t("ui.sessionTurn.diffs.changed")} {" "}
          {language.t(props.diffs.length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !showAll())}>
            {showAll() ? language.t("ui.sessionTurn.diffs.showLess") : language.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const view = normalize(diff)

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <div data-slot="session-turn-diff-trigger">
                        <span data-slot="session-turn-diff-path">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                          </Show>
                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                        </span>
                        <div data-slot="session-turn-diff-meta">
                          <span data-slot="session-turn-diff-changes">
                            <DiffChanges changes={diff} />
                          </span>
                          <span data-slot="session-turn-diff-chevron">
                            <Icon name="chevron-down" size="small" />
                          </span>
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <div data-slot="session-turn-diff-view" data-scrollable>
                      <Dynamic component={fileComponent} mode="diff" fileDiff={view.fileDiff} />
                    </div>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!showAll() && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
          </div>
        </Show>
      </div>
    </div>
  )
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  historyShift: boolean
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const platform = usePlatform()

  let virtualizer: VirtualizerHandle | undefined
  const sessionID = createMemo(() => params.id)
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const messageByID = createMemo(() => new Map(sessionMessages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of sessionMessages()) {
      if (message.role !== "assistant") continue
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        continue
      }
      result.set(message.parentID, [message])
    }
    return result
  })
  const pending = createMemo(() =>
    sessionMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const working = createMemo(() => sessionStatus().type !== "idle")
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const shareUrl = createMemo(() => info()?.share?.url)
  const shareEnabled = createMemo(() => sync.data.config.share !== "disabled")
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync.session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))

  const messageRowMemos = createMemo(
    mapArray(
      () => props.userMessages,
      (userMessage, indexAccessor) => {
        return createMemo((previous: TimelineRow[] | undefined) => {
          const rows: TimelineRow[] = []
          const status = sessionStatus()
          const active = activeMessageID()
          const showReasoning = settings.general.showReasoningSummaries()

          const userParts = sync.data.part[userMessage.id] ?? emptyParts
          const comments = messageComments(userParts)
          const assistantMessages = assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages
          const compaction = userParts.find((part) => part.type === "compaction")
          const interrupted = assistantMessages.some((message) => message.error?.name === "MessageAbortedError")
          const error = assistantMessages.find((message) => message.error?.name !== "MessageAbortedError")?.error
          const workingTurn = status.type !== "idle" && active === userMessage.id
          const assistantPartRefs = assistantMessages.flatMap((message) =>
            (sync.data.part[message.id] ?? emptyParts)
              .filter((part) => renderable(part, showReasoning))
              .map((part) => ({ messageID: message.id, part })),
          )
          const assistantGroups = groupParts(assistantPartRefs)
          const diffs = (userMessage.summary?.diffs ?? [])
            .reduceRight<SummaryDiff[]>((result, diff) => {
              if (!summaryDiff(diff)) return result
              if (result.some((item) => item.file === diff.file)) return result
              result.push(diff)
              return result
            }, [])
            .reverse()
          const heading = assistantMessages
            .flatMap((message) => sync.data.part[message.id] ?? emptyParts)
            .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
            .find((value): value is string => !!value)

          const previousUserMessage = indexAccessor() > 0
          if (comments.length > 0)
            rows.push({
              key: `comment-strip:${userMessage.id}`,
              type: "comment-strip",
              userMessageID: userMessage.id,
              previousUserMessage,
            })

          rows.push({
            key: `user-message:${userMessage.id}`,
            type: "user-message",
            userMessageID: userMessage.id,
            anchor: comments.length === 0,
            previousUserMessage: comments.length === 0 && previousUserMessage,
          })

          if (compaction || interrupted) {
            rows.push({
              key: `turn-divider:${userMessage.id}:${compaction ? "compaction" : "interrupted"}`,
              type: "turn-divider",
              userMessageID: userMessage.id,
              label: compaction ? "compaction" : "interrupted",
            })
          }

          assistantGroups.forEach((group, index) =>
            rows.push({
              key: `assistant-part:${userMessage.id}:${group.key}`,
              type: "assistant-part",
              userMessageID: userMessage.id,
              group,
              previousAssistantPart: index > 0,
              lastAssistantPart: index === assistantGroups.length - 1,
            }),
          )

          if (workingTurn && !error && status.type !== "retry" && (showReasoning ? assistantPartRefs.length === 0 : true)) {
            rows.push({ key: `thinking:${userMessage.id}`, type: "thinking", userMessageID: userMessage.id, reasoningHeading: heading })
          }

          if (workingTurn && status.type === "retry") rows.push({ key: `retry:${userMessage.id}`, type: "retry", userMessageID: userMessage.id })

          if (diffs.length > 0 && !workingTurn) {
            rows.push({ key: `diff-summary:${userMessage.id}`, type: "diff-summary", userMessageID: userMessage.id, diffs })
          }

          if (error) {
            const data = error.data?.message
            rows.push({
              key: `error:${userMessage.id}`,
              type: "error",
              userMessageID: userMessage.id,
              text: unwrapErrorMessage(typeof data === "string" ? data : data === undefined || data === null ? "" : String(data)),
            })
          }

          return reuseTimelineRows(previous, rows)
        })
      }
    )
  )

  const timelineRows = createMemo((previous: TimelineRow[] | undefined) => {
    const rows = messageRowMemos().flatMap((memo) => memo())
    if (rows.length === 0) return rows
    return reuseTimelineRows(previous, [...rows, { key: "bottom-spacer", type: "bottom-spacer" }])
  })
  const timelineRowKeys = createMemo(() => timelineRows().map((row) => row.key), [] as string[], { equals: sameKeys })
  const virtualCache = createMemo(() => readTimelineCache(sessionKey(), timelineRowKeys()))
  const timelineRowByKey = createMemo(() => new Map(timelineRows().map((row) => [row.key, row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    timelineRows().forEach((row, index) => {
      if (!("userMessageID" in row)) return
      if (result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const keepMounted = createMemo(() => {
    const id = activeMessageID()
    if (!id) return
    const rows = timelineRows()
    const index = rows.findLastIndex((row) => "userMessageID" in row && row.userMessageID === id)
    if (index < 0) return
    return [index]
  })

  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer?.scrollToIndex(index, { align: "center" })
    })
  })

  let cacheSessionKey = sessionKey()
  let cacheRowKeys = timelineRowKeys()
  let virtualizerSessionKey = cacheSessionKey
  let virtualizerRowKeys = cacheRowKeys

  createEffect(
    on(
      () => [sessionKey(), timelineRowKeys()] as const,
      (next, prev) => {
        if (prev && prev[0] !== next[0]) writeTimelineCache(prev[0], prev[1], virtualizer)
        cacheSessionKey = next[0]
        cacheRowKeys = next[1]
        if (virtualizer) {
          virtualizerSessionKey = cacheSessionKey
          virtualizerRowKeys = cacheRowKeys
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    writeTimelineCache(virtualizerSessionKey, virtualizerRowKeys, virtualizer)
    props.setRevealMessage?.(() => {})
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
    pendingShare: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [share, setShare] = createStore({
    open: false,
    dismiss: null as "escape" | "outside" | null,
  })
  const [bar, setBar] = createStore({
    ms: pace(640),
  })

  let more: HTMLButtonElement | undefined
  let head: HTMLDivElement | undefined
  let listRoot: HTMLDivElement | undefined
  let listFrame: number | undefined
  let contentFrame: number | undefined
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()

  const updateTitleMetrics = () => {
    if (!head || head.clientWidth <= 0) return
    setBar("ms", pace(head.clientWidth))
  }

  createResizeObserver(
    () => head,
    updateTitleMetrics,
  )

  const bindContentRoot = (root: HTMLDivElement) => {
    const child = root.firstElementChild
    props.setContentRef(child instanceof HTMLDivElement ? child : root)
  }

  const scheduleContentRoot = (root: HTMLDivElement) => {
    if (contentFrame !== undefined) cancelAnimationFrame(contentFrame)
    contentFrame = requestAnimationFrame(() => {
      contentFrame = undefined
      if (listRoot !== root) return
      bindContentRoot(root)
    })
  }

  const connectListRoot = (root: HTMLDivElement) => {
    if (listRoot !== root) return
    if (!root.isConnected || !root.ownerDocument.defaultView) {
      listFrame = requestAnimationFrame(() => {
        listFrame = undefined
        connectListRoot(root)
      })
      return
    }

    props.setScrollRef(root)
    setScrollRoot(root)
    scheduleContentRoot(root)
  }

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot) return

    if (listFrame !== undefined) cancelAnimationFrame(listFrame)
    if (contentFrame !== undefined) cancelAnimationFrame(contentFrame)
    listRoot = root
    setScrollRoot(undefined)
    connectListRoot(root)
  }

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    const root = event.currentTarget
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: root.clientHeight,
    })
    if (!delta) return
    markBoundaryGesture({ root, target: event.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
  }

  const handleListTouchStart = (event: TouchEvent) => {
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    markBoundaryGesture({ root: event.currentTarget, target: event.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.target !== event.currentTarget) return
    props.onMarkScrollGesture(event.currentTarget)
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    if (!props.hasScrollGesture()) return
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    if (listFrame !== undefined) cancelAnimationFrame(listFrame)
    if (contentFrame !== undefined) cancelAnimationFrame(contentFrame)
    setScrollRoot(undefined)
    props.setScrollRef(undefined)
  })

  const viewShare = () => {
    const url = shareUrl()
    if (!url) return
    platform.openLink(url)
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const shareMutation = useMutation(() => ({
    mutationFn: (id: string) => globalSDK.client.session.share({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to share session", err)
    },
  }))

  const unshareMutation = useMutation(() => ({
    mutationFn: (id: string) => globalSDK.client.session.unshare({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to unshare session", err)
    },
  }))

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const shareSession = () => {
    const id = sessionID()
    if (!id || shareMutation.isPending) return
    if (!shareEnabled()) return
    shareMutation.mutate(id)
  }

  const unshareSession = () => {
    const id = sessionID()
    if (!id || unshareMutation.isPending) return
    if (!shareEnabled()) return
    unshareMutation.mutate(id)
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
          pendingShare: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync.data.message[id] !== undefined) return
        void sync.session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync.session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (max, item) => {
        const completed = item.time.completed
        if (typeof completed !== "number") return max
        if (max === undefined) return completed
        return Math.max(max, completed)
      },
      undefined,
    )
    if (typeof end !== "number") return
    if (end < message.time.created) return
    return end - message.time.created
  }

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = sync.data.part[message.id] ?? emptyParts
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }
  }

  const partByRef = (messageID: string, partID: string) =>
    (sync.data.part[messageID] ?? emptyParts).find((part) => part.id === partID)

  const renderAssistantPartGroup = (row: Extract<TimelineRow, { type: "assistant-part" }>) => {
    if (row.group.type === "context") {
      const parts = row.group.refs
        .map((ref) => partByRef(ref.messageID, ref.partID))
        .filter((part): part is ToolPart => part?.type === "tool")

      return <ContextToolGroup parts={parts} busy={workingTurn(row.userMessageID) && row.lastAssistantPart} />
    }

    const message = messageByID().get(row.group.ref.messageID)
    const part = partByRef(row.group.ref.messageID, row.group.ref.partID)
    if (!message || !part) return null

    return (
      <MessagePart
        part={part}
        message={message}
        showAssistantCopyPartID={assistantCopyPartID(row.userMessageID)}
        turnDurationMs={turnDurationMs(row.userMessageID)}
        defaultOpen={partDefaultOpen(part, settings.general.shellToolPartsExpanded(), settings.general.editToolPartsExpanded())}
        deferToolContent={false}
      />
    )
  }

  function TimelineRowFrame(input: { row: FramedTimelineRow; children: JSX.Element }) {
    const anchor = () => input.row.type === "comment-strip" || (input.row.type === "user-message" && input.row.anchor)

    return (
      <div
        id={anchor() ? props.anchor(input.row.userMessageID) : undefined}
        data-message-id={input.row.userMessageID}
        data-timeline-row={input.row.type}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-200 2xl:max-w-[1000px]": props.centered,
          "md:mx-auto": props.centered,
          "pt-6":
            (input.row.type === "comment-strip" || input.row.type === "user-message") && input.row.previousUserMessage,
          "pt-3": input.row.type === "assistant-part" && input.row.previousAssistantPart,
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: TimelineRow) => {
    switch (row.type) {
      case "comment-strip":
        return (
          <TimelineRowFrame row={row}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={messageComments(sync.data.part[row.userMessageID] ?? emptyParts)}>
                    {(commentAccessor: () => MessageComment) => {
                      const comment = createMemo(() => commentAccessor())
                      return (
                        <Show when={comment()}>
                          {(c) => (
                            <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                              <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                <FileIcon node={{ path: c().path, type: "file" }} class="size-3.5 shrink-0" />
                                <span class="truncate">{getFilename(c().path)}</span>
                                <Show when={c().selection}>
                                  {(selection) => (
                                    <span class="shrink-0 text-text-weak">
                                      {selection().startLine === selection().endLine
                                        ? `:${selection().startLine}`
                                        : `:${selection().startLine}-${selection().endLine}`}
                                    </span>
                                  )}
                                </Show>
                              </div>
                              <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                {c().comment}
                              </div>
                            </div>
                          )}
                        </Show>
                      )
                    }}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      case "user-message": {
        const message = messageByID().get(row.userMessageID)
        if (!message || message.role !== "user") return null
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-message-content" aria-live="off">
                <Message message={message} parts={sync.data.part[row.userMessageID] ?? emptyParts} actions={props.actions} />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "turn-divider":
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={language.t(row.label === "compaction" ? "ui.messagePart.compaction" : "ui.message.interrupted")}
                />
              </div>
            </div>
          </TimelineRowFrame>
        )
      case "assistant-part":
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-assistant-content" aria-hidden={workingTurn(row.userMessageID)}>
                {renderAssistantPartGroup(row)}
              </div>
            </div>
          </TimelineRowFrame>
        )
      case "thinking":
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                reasoningHeading={row.reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      case "retry":
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <SessionRetry status={sessionStatus()} show={activeMessageID() === row.userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      case "diff-summary":
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow diffs={row.diffs} />
            </div>
          </TimelineRowFrame>
        )
      case "error":
        return (
          <TimelineRowFrame row={row}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Card variant="error" class="error-card">
                {row.text}
              </Card>
            </div>
          </TimelineRowFrame>
        )
      case "bottom-spacer":
        return <div data-timeline-row="bottom-spacer" aria-hidden="true" class="h-16" />
    }
  }

  function TimelineRowView(props: { rowKey: string }) {
    const row = createMemo(() => timelineRowByKey().get(props.rowKey))

    return <Show when={row()} keyed>{(item) => renderTimelineRow(item)}</Show>
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
            "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          }}
        >
          <button
            class="pointer-events-auto flex items-center justify-center w-10 h-8 bg-transparent border-none cursor-pointer p-0 group"
            onClick={props.onResumeScroll}
          >
            <div
              class="flex items-center justify-center w-8 h-6 rounded-[6px] border border-border-weaker-base bg-[color-mix(in_srgb,var(--surface-raised-stronger-non-alpha)_80%,transparent)] backdrop-blur-[0.75px] transition-colors group-hover:border-[var(--border-weak-base)] group-hover:[--icon-base:var(--icon-hover)]"
              style={{
                "box-shadow":
                  "0 51px 60px 0 rgba(0,0,0,0.10), 0 15px 18px 0 rgba(0,0,0,0.12), 0 6.386px 7.513px 0 rgba(0,0,0,0.12), 0 2.31px 2.717px 0 rgba(0,0,0,0.20)",
              }}
            >
              <Icon name="arrow-down-to-line" size="small" />
            </div>
          </button>
        </div>
        <div
          class="relative min-w-0 w-full h-full flex flex-col"
          style={{
            "--session-title-height": showHeader() ? "40px" : "0px",
            "--sticky-accordion-top": showHeader() ? "48px" : "0px",
          }}
        >
          <Show when={showHeader()}>
              <div
                ref={(el) => {
                  head = el
                  updateTitleMetrics()
                }}
                data-session-title
                classList={{
                  "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
                  relative: true,
                  "w-full": true,
                  "pb-4": true,
                  "pl-2 pr-3 md:pl-4 md:pr-3": true,
                  "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                }}
              >
                <Show when={workingStatus() !== "hidden" && settings.general.showSessionProgressBar()}>
                  <div
                    data-component="session-progress"
                    data-state={workingStatus()}
                    aria-hidden="true"
                    style={{
                      "--session-progress-color": tint() ?? "var(--icon-interactive-base)",
                      "--session-progress-ms": `${bar.ms}ms`,
                    }}
                  >
                    <div data-component="session-progress-bar" />
                  </div>
                </Show>
                <div class="h-12 w-full flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                    <div class="flex items-center min-w-0 grow-1">
                      <Show when={parentID()}>
                        <button
                          type="button"
                          data-slot="session-title-parent"
                          class="min-w-0 max-w-[40%] truncate text-14-medium text-text-weak transition-colors hover:text-text-base"
                          onClick={navigateParent}
                        >
                          {parentTitle()}
                        </button>
                        <span
                          data-slot="session-title-separator"
                          class="px-2 text-14-medium text-text-weak"
                          aria-hidden="true"
                        >
                          /
                        </span>
                      </Show>
                      <div
                        class="shrink-0 flex items-center justify-center overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                        style={{
                          width: working() ? "16px" : "0px",
                          "margin-right": working() ? "8px" : "0px",
                        }}
                        aria-hidden="true"
                      >
                        <Show when={workingStatus() !== "hidden"}>
                          <div
                            class="transition-opacity duration-200 ease-out"
                            classList={{ "opacity-0": workingStatus() === "hiding" }}
                          >
                            <Spinner class="size-4" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
                          </div>
                        </Show>
                      </div>
                      <Show when={childTitle() || title.editing}>
                        <Show
                          when={title.editing}
                          fallback={
                            <h1
                              data-slot="session-title-child"
                              class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                              onDblClick={openTitleEditor}
                            >
                              {childTitle()}
                            </h1>
                          }
                        >
                          <InlineInput
                            ref={(el) => {
                              titleRef = el
                            }}
                            data-slot="session-title-child"
                            value={title.draft}
                            disabled={titleMutation.isPending}
                            class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px] pl-1 -ml-1"
                            style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                            onInput={(event) => setTitle("draft", event.currentTarget.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === "Enter") {
                                event.preventDefault()
                                void saveTitleEditor()
                                return
                              }
                              if (event.key === "Escape") {
                                event.preventDefault()
                                closeTitleEditor()
                              }
                            }}
                            onBlur={closeTitleEditor}
                          />
                        </Show>
                      </Show>
                    </div>
                  </div>
                  <Show when={sessionID()} keyed>
                    {(id) => (
                      <div class="shrink-0 flex items-center gap-3">
                        <SessionContextUsage placement="bottom" />
                        <Show when={!parentID()}>
                          <DropdownMenu
                            gutter={4}
                            placement="bottom-end"
                            open={title.menuOpen}
                            onOpenChange={(open) => {
                              setTitle("menuOpen", open)
                              if (open) return
                            }}
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              classList={{
                                "bg-surface-base-active": share.open || title.pendingShare,
                              }}
                              aria-label={language.t("common.moreOptions")}
                              aria-expanded={title.menuOpen || share.open || title.pendingShare}
                              ref={(el: HTMLButtonElement) => {
                                more = el
                              }}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                style={{ "min-width": "104px" }}
                                onCloseAutoFocus={(event) => {
                                  if (title.pendingRename) {
                                    event.preventDefault()
                                    setTitle("pendingRename", false)
                                    openTitleEditor()
                                    return
                                  }
                                  if (title.pendingShare) {
                                    event.preventDefault()
                                    requestAnimationFrame(() => {
                                      setShare({ open: true, dismiss: null })
                                      setTitle("pendingShare", false)
                                    })
                                  }
                                }}
                              >
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle("pendingRename", true)
                                    setTitle("menuOpen", false)
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <Show when={shareEnabled()}>
                                  <DropdownMenu.Item
                                    onSelect={() => {
                                      setTitle({ pendingShare: true, menuOpen: false })
                                    }}
                                  >
                                    <DropdownMenu.ItemLabel>
                                      {language.t("session.share.action.share")}
                                    </DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </Show>
                                <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                                  <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Separator />
                                <DropdownMenu.Item
                                  onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>

                          <KobaltePopover
                            open={share.open}
                            anchorRef={() => more}
                            placement="bottom-end"
                            gutter={4}
                            modal={false}
                            onOpenChange={(open) => {
                              if (open) setShare("dismiss", null)
                              setShare("open", open)
                            }}
                          >
                            <KobaltePopover.Portal>
                              <KobaltePopover.Content
                                data-component="popover-content"
                                style={{ "min-width": "320px" }}
                                onEscapeKeyDown={(event) => {
                                  setShare({ dismiss: "escape", open: false })
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onPointerDownOutside={() => {
                                  setShare({ dismiss: "outside", open: false })
                                }}
                                onFocusOutside={() => {
                                  setShare({ dismiss: "outside", open: false })
                                }}
                                onCloseAutoFocus={(event) => {
                                  if (share.dismiss === "outside") event.preventDefault()
                                  setShare("dismiss", null)
                                }}
                              >
                                <div class="flex flex-col p-3">
                                  <div class="flex flex-col gap-1">
                                    <div class="text-13-medium text-text-strong">
                                      {language.t("session.share.popover.title")}
                                    </div>
                                    <div class="text-12-regular text-text-weak">
                                      {shareUrl()
                                        ? language.t("session.share.popover.description.shared")
                                        : language.t("session.share.popover.description.unshared")}
                                    </div>
                                  </div>
                                  <div class="mt-3 flex flex-col gap-2">
                                    <Show
                                      when={shareUrl()}
                                      fallback={
                                        <Button
                                          size="large"
                                          variant="primary"
                                          class="w-full"
                                          onClick={shareSession}
                                          disabled={shareMutation.isPending}
                                        >
                                          {shareMutation.isPending
                                            ? language.t("session.share.action.publishing")
                                            : language.t("session.share.action.publish")}
                                        </Button>
                                      }
                                    >
                                      <div class="flex flex-col gap-2">
                                        <TextField
                                          value={shareUrl() ?? ""}
                                          readOnly
                                          copyable
                                          copyKind="link"
                                          tabIndex={-1}
                                          class="w-full"
                                        />
                                        <div class="grid grid-cols-2 gap-2">
                                          <Button
                                            size="large"
                                            variant="secondary"
                                            class="w-full shadow-none border border-border-weak-base"
                                            onClick={unshareSession}
                                            disabled={unshareMutation.isPending}
                                          >
                                            {unshareMutation.isPending
                                              ? language.t("session.share.action.unpublishing")
                                              : language.t("session.share.action.unpublish")}
                                          </Button>
                                          <Button
                                            size="large"
                                            variant="primary"
                                            class="w-full"
                                            onClick={viewShare}
                                            disabled={unshareMutation.isPending}
                                          >
                                            {language.t("session.share.action.view")}
                                          </Button>
                                        </div>
                                      </div>
                                    </Show>
                                  </div>
                                </div>
                              </KobaltePopover.Content>
                            </KobaltePopover.Portal>
                          </KobaltePopover>
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
          </Show>
          <ScrollView
            viewportRef={bindListRoot}
            onWheel={handleListWheel}
            onTouchStart={handleListTouchStart}
            onTouchMove={handleListTouchMove}
            onTouchEnd={handleListTouchEnd}
            onTouchCancel={handleListTouchEnd}
            onPointerDown={handleListPointerDown}
            onScroll={handleListScroll}
            onClick={props.onAutoScrollInteraction}
            class="relative min-w-0 w-full h-full"
          >
            <Show when={scrollRoot()}>
              {(root) => (
                <Virtualizer
                  data={timelineRowKeys()}
                  cache={virtualCache()}
                  scrollRef={root()}
                  shift={props.historyShift}
                  keepMounted={keepMounted()}
                  ref={(handle) => {
                    if (!handle) {
                      writeTimelineCache(virtualizerSessionKey, virtualizerRowKeys, virtualizer)
                      virtualizer = undefined
                      return
                    }
                    virtualizer = handle
                    virtualizerSessionKey = cacheSessionKey
                    virtualizerRowKeys = cacheRowKeys
                    scheduleContentRoot(root())
                  }}
                >
                  {(key) => <TimelineRowView rowKey={key} />}
                </Virtualizer>
              )}
            </Show>
          </ScrollView>
        </div>
      </div>
    </Show>
  )
}
