import { type Client, type ConversationSummary } from "@cybros/agent"
import { Schema } from "effect"
import { personalDeskSurface } from "./channels"
import { changeDocument, StoreDocument } from "./document"

export const inboxNamespace = "rho.inbox"
export const indefinite = "indefinite"

// The reference parses with Time.iso8601: extended ISO-8601 only, never free-form dates.
const iso8601Input = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/

export class InboxError extends Error {}

const InboxEntry = Schema.Struct({
  read_at: Schema.optional(Schema.String),
  snoozed_until: Schema.optional(Schema.String),
  snoozed_at: Schema.optional(Schema.String),
})
export type InboxEntry = typeof InboxEntry.Type

const StoredState = Schema.Struct({ entries: Schema.optional(Schema.Record(Schema.String, InboxEntry)) })
type State = { entries: Record<string, InboxEntry> }

const decodeState = (value: unknown): State => ({
  entries: Schema.decodeUnknownSync(StoredState)(value ?? {}).entries ?? {},
})

export type InboxItem = {
  public_id: string
  workspace_public_id: string
  title: string
  is_personal_desk: boolean
  has_automation: boolean
  run_status?: string
  reason: "awaiting_decision" | "execution_failed" | "working" | "automation_enabled" | "ready"
  last_activity_at: string
  snoozed_until?: string
  read_at?: string
  section?: "done"
}

export type InboxSections = {
  needs_you: InboxItem[]
  running: InboxItem[]
  snoozed: InboxItem[]
  done: InboxItem[]
}

export type InboxPartition = {
  personal_desk: InboxItem | null
  sections: InboxSections
  counts: { needs_you: number; running: number; snoozed: number; done: number; skill_drafts: number }
}

export type CompleteResult =
  | { outcome: "marked_read"; conversation_public_id: string; inbox_entry: InboxEntry }
  | { outcome: "returned_to_running"; conversation_public_id: string; inbox_entry: InboxEntry }
  | { outcome: "archived"; conversation_public_id: string }

type ActiveRun = { status?: string }

/**
 * Whose-Turn Task Inbox (`needs_you`, `running`, `snoozed`, `done`): conversations waiting on a
 * decision or failed run land in `needs_you`, active executions and standing automation in
 * `running`, deferred work in `snoozed` until new activity wakes it, and archived work in `done`.
 * Completing a conversation that still owns an active schedule or subscription marks the round
 * read without archiving its workspace; ordinary conversations archive cleanly.
 */
export class Inbox {
  constructor(
    private readonly store: Client["profile"]["storeEntries"],
    private readonly clock: () => Date = () => new Date(),
    private readonly skillDrafts: () => Promise<number> = () => Promise.resolve(0),
  ) {}

  async partition(input: {
    client: Client
    workspace_public_id: string
    active_runs?: Record<string, ActiveRun>
    desk_public_id?: string
  }): Promise<InboxPartition> {
    const activeRuns = input.active_runs ?? {}
    const workspace = input.client.workspace(input.workspace_public_id)
    const state = await this.readState(input.workspace_public_id)
    const activePage = (await workspace.conversations.list({ limit: 100 })).items
    const archivedPage = (await workspace.conversations.archived({ limit: 40 })).items
    const scheduledConversationIds = new Set(
      (await workspace.schedules.list({ limit: 100 })).items
        .filter((schedule) => schedule.status === "active")
        .map((schedule) => schedule.conversation_public_id)
        .filter((id): id is string => id !== null),
    )

    const sections: InboxSections = { needs_you: [], running: [], snoozed: [], done: [] }
    let deskRow: InboxItem | null = null
    const now = this.clock()

    for (const conversation of activePage) {
      if (conversation.side || subagent(conversation)) continue

      const meta = state.entries[conversation.public_id] ?? {}
      const run = activeRuns[conversation.public_id]
      const hasLiveSubscription =
        activePage.length <= 40 &&
        (await workspace.conversation(conversation.public_id).threadSubscriptions.list()).some(
          (subscription) => subscription.stopped_at === null,
        )
      const hasAutomation = scheduledConversationIds.has(conversation.public_id) || hasLiveSubscription
      const isDesk = conversation.public_id === input.desk_public_id
      const item = projectItem({ conversation, meta, run, hasAutomation, isDesk })

      if (isDesk) deskRow = item

      const section = classify({ conversation, meta, run, hasAutomation, isDesk, now })
      if (section) sections[section].push(item)
    }

    sections.snoozed.sort((a, b) => {
      const keyA = snoozeSortKey(a)
      const keyB = snoozeSortKey(b)

      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
    })
    for (const conversation of archivedPage) {
      if (conversation.side || subagent(conversation)) continue

      sections.done.push({
        ...projectItem({
          conversation,
          meta: state.entries[conversation.public_id] ?? {},
          run: undefined,
          hasAutomation: false,
          isDesk: false,
        }),
        section: "done",
      })
    }

    return {
      personal_desk: deskRow,
      sections,
      counts: {
        needs_you: sections.needs_you.length,
        running: sections.running.length,
        snoozed: sections.snoozed.length,
        done: sections.done.length,
        skill_drafts: await this.skillDrafts(),
      },
    }
  }

  async snooze(input: {
    workspace_public_id: string
    conversation_public_id: string
    until_at: string | null
  }): Promise<InboxEntry> {
    const conversationId = requiredId(input.conversation_public_id, "conversation_public_id")
    const now = this.clock()
    const target = normalizeUntil(input.until_at, now)

    return this.mutateEntry(input.workspace_public_id, conversationId, (entry) => {
      if (target === null) {
        const cleared = { ...entry }

        delete cleared.snoozed_until
        delete cleared.snoozed_at
        return cleared
      }
      return { ...entry, snoozed_until: target, snoozed_at: iso8601(now) }
    })
  }

  async markRead(input: {
    workspace_public_id: string
    conversation_public_id: string
    activity_at?: string
  }): Promise<InboxEntry> {
    const conversationId = requiredId(input.conversation_public_id, "conversation_public_id")
    const stamp = input.activity_at ?? iso8601(this.clock())

    return this.mutateEntry(input.workspace_public_id, conversationId, (entry) => ({ ...entry, read_at: stamp }))
  }

  async complete(input: {
    client: Client
    workspace_public_id: string
    conversation_public_id: string
  }): Promise<CompleteResult> {
    const conversationId = requiredId(input.conversation_public_id, "conversation_public_id")
    const workspace = input.client.workspace(input.workspace_public_id)
    const conversation = await workspace.conversation(conversationId).fetch()

    if (conversation.metadata["opencode.surface"] === personalDeskSurface) {
      const entry = await this.markRead({
        workspace_public_id: input.workspace_public_id,
        conversation_public_id: conversationId,
        activity_at: conversation.last_activity_at ?? iso8601(this.clock()),
      })

      return { outcome: "marked_read", conversation_public_id: conversationId, inbox_entry: entry }
    }

    const hasLiveSchedule = (await workspace.schedules.list({ limit: 100 })).items.some(
      (schedule) => schedule.status === "active" && schedule.conversation_public_id === conversationId,
    )
    const hasLiveSubscription = (await workspace.conversation(conversationId).threadSubscriptions.list()).some(
      (subscription) => subscription.stopped_at === null,
    )

    if (hasLiveSchedule || hasLiveSubscription) {
      const entry = await this.mutateEntry(input.workspace_public_id, conversationId, (row) => {
        const next = { ...row, read_at: conversation.last_activity_at ?? iso8601(this.clock()) }

        delete next.snoozed_until
        delete next.snoozed_at
        return next
      })

      return { outcome: "returned_to_running", conversation_public_id: conversationId, inbox_entry: entry }
    }

    await this.mutateEntry(input.workspace_public_id, conversationId, (row) => {
      const next = { ...row }

      delete next.snoozed_until
      delete next.snoozed_at
      return next
    })
    const archived = await workspace.conversation(conversationId).archive()

    return { outcome: "archived", conversation_public_id: archived.public_id }
  }

  private documentFor(workspacePublicId: string) {
    return new StoreDocument(this.store, inboxNamespace, "workspace:" + workspacePublicId, decodeState)
  }

  private async readState(workspacePublicId: string): Promise<State> {
    return (await this.documentFor(workspacePublicId).read()) ?? { entries: {} }
  }

  private async mutateEntry(
    workspacePublicId: string,
    conversationId: string,
    edit: (entry: InboxEntry) => InboxEntry,
  ): Promise<InboxEntry> {
    let saved: InboxEntry = {}

    await changeDocument(this.documentFor(workspacePublicId), (current) => {
      const entries = { ...(current?.entries ?? {}) }
      const row = edit({ ...entries[conversationId] })

      saved = row
      if (Object.keys(row).length === 0) {
        delete entries[conversationId]
        return { entries }
      }
      entries[conversationId] = row
      return { entries }
    })
    return saved
  }
}

// Mirrors the Ruby SDK's Conversation#busy? and #subagent? derivations.
function busy(conversation: ConversationSummary): boolean {
  return conversation.active_turn_public_id !== null
}

function subagent(conversation: ConversationSummary): boolean {
  return conversation.parent !== null && conversation.taken_over_at === null
}

function classify(input: {
  conversation: ConversationSummary
  meta: InboxEntry
  run: ActiveRun | undefined
  hasAutomation: boolean
  isDesk: boolean
  now: Date
}): "needs_you" | "running" | "snoozed" | null {
  const status = input.run?.status ?? ""
  const activityAt = parseTime(input.conversation.last_activity_at ?? input.conversation.created_at)
  const readAt = parseTime(input.meta.read_at)
  const unread = activityAt !== null && (readAt === null || activityAt.getTime() > readAt.getTime())

  const snoozedUntil = input.meta.snoozed_until
  const snoozedAt = parseTime(input.meta.snoozed_at)

  if (
    snoozedUntil !== undefined &&
    !(activityAt !== null && snoozedAt !== null && activityAt.getTime() > snoozedAt.getTime())
  ) {
    if (snoozedUntil === indefinite) return "snoozed"

    const due = parseTime(snoozedUntil)
    if (due !== null && due.getTime() > input.now.getTime()) return "snoozed"
  }

  if (status === "needs_attention" || status === "failed" || status === "uncertain") return "needs_you"
  if (["running", "pending", "queued", "waiting", "paused"].includes(status) || busy(input.conversation))
    return "running"
  if (input.isDesk) return unread ? "needs_you" : null
  if (input.hasAutomation) return unread ? "needs_you" : "running"
  return "needs_you"
}

function projectItem(input: {
  conversation: ConversationSummary
  meta: InboxEntry
  run: ActiveRun | undefined
  hasAutomation: boolean
  isDesk: boolean
}): InboxItem {
  const status = input.run?.status ?? ""

  return {
    public_id: input.conversation.public_id,
    workspace_public_id: input.conversation.workspace_public_id,
    title: input.conversation.title ?? (input.isDesk ? "Personal Desk" : "Untitled task"),
    is_personal_desk: input.isDesk,
    has_automation: input.hasAutomation,
    ...(status === "" ? {} : { run_status: status }),
    reason: reasonFor(status, input.conversation, input.hasAutomation),
    last_activity_at: input.conversation.last_activity_at ?? input.conversation.created_at,
    ...(input.meta.snoozed_until === undefined ? {} : { snoozed_until: input.meta.snoozed_until }),
    ...(input.meta.read_at === undefined ? {} : { read_at: input.meta.read_at }),
  }
}

function reasonFor(status: string, conversation: ConversationSummary, hasAutomation: boolean): InboxItem["reason"] {
  if (status === "needs_attention") return "awaiting_decision"
  if (status === "failed" || status === "uncertain") return "execution_failed"
  if (["running", "pending", "queued", "waiting"].includes(status) || busy(conversation)) return "working"
  if (hasAutomation) return "automation_enabled"
  return "ready"
}

function snoozeSortKey(item: InboxItem): string {
  if (item.snoozed_until === indefinite) return "9999-12-31T23:59:59Z"
  return item.snoozed_until ?? ""
}

function normalizeUntil(untilAt: string | null, now: Date): string | null {
  const clean = untilAt?.trim() ?? ""

  if (clean === "") return null
  if (clean === indefinite) return indefinite

  const parsed = new Date(clean)

  if (!iso8601Input.test(clean) || Number.isNaN(parsed.getTime()))
    throw new InboxError("until_at must be an ISO-8601 timestamp, 'indefinite', or null")
  if (parsed.getTime() <= now.getTime()) throw new InboxError("snooze time must be in the future")
  return iso8601(parsed)
}

function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null

  const parsed = new Date(value)

  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function requiredId(value: string, name: string): string {
  const clean = value.trim()

  if (clean === "") throw new InboxError(name + " is required")
  return clean
}

// rho stamps entries with Time#iso8601, which is UTC at whole-second precision.
function iso8601(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}
