import {
  NotFound,
  type Client,
  type Conversation,
  type ExternalTrigger,
  type IngestTrigger,
  type OutboxMessage,
} from "@cybros/agent"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { changeDocument, StoreDocument } from "./document"
import { memoryContext } from "./speakers"
import { personalBot } from "./bots"

export const channelsNamespace = "rho.channels"
export const channelsKey = "state"
export const acceptModes = ["off", "observe", "auto"]
export const purposes = ["acknowledgement", "answer", "attention", "result"]
export const subscriptionModes = ["active", "context_only"]
export const doesModes = ["act", "check_in"]
export const actorKinds = ["human", "bot", "system"]
export const sourceKeyPattern = /^[a-z0-9][a-z0-9:._-]{0,63}$/
export const hhMmPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
export const maxObservations = 50
export const personalDeskSurface = "personal_desk"

export class ChannelsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

const SourceEntry = Schema.Struct({
  source_key: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  enabled: Schema.Boolean,
  target: Schema.String,
  accept_mode: Schema.String,
  allowed_senders: Schema.Array(Schema.String),
  allowed_bots: Schema.Array(Schema.String),
  updated_at: Schema.optional(Schema.String),
})
export type ChannelSource = typeof SourceEntry.Type

const EventRule = Schema.Struct({
  public_id: Schema.String,
  name: Schema.String,
  source_key: Schema.String,
  pattern: Schema.optional(Schema.String),
  instructions: Schema.String,
  does: Schema.String,
  enabled: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type EventRule = typeof EventRule.Type

const Observation = Schema.Struct({
  public_id: Schema.String,
  source_key: Schema.String,
  external_id: Schema.String,
  thread_key: Schema.String,
  decision: Schema.String,
  matched_rules: Schema.Array(Schema.String),
  preview: Schema.String,
  observed_at: Schema.String,
})
export type Observation = typeof Observation.Type

const RecentTrigger = Schema.Struct({
  source_key: Schema.String,
  thread_key: Schema.String,
  external_id: Schema.String,
  trigger_public_id: Schema.String,
})

const AttentionPolicy = Schema.Struct({
  quiet_hours: Schema.Struct({
    enabled: Schema.Boolean,
    start: Schema.String,
    end: Schema.String,
    time_zone: Schema.String,
  }),
  daily_proactive_limit: Schema.Int,
})
export type AttentionPolicy = typeof AttentionPolicy.Type

const State = Schema.Struct({
  sources: Schema.Record(Schema.String, SourceEntry),
  event_rules: Schema.Array(EventRule),
  observations: Schema.Array(Observation),
  recent_triggers: Schema.Array(RecentTrigger),
  desks: Schema.Record(Schema.String, Schema.String),
  proactive_counter: Schema.Struct({
    date: Schema.optional(Schema.String),
    count: Schema.optional(Schema.Int),
  }),
  attention_policy: AttentionPolicy,
})
type State = typeof State.Type

// Missing keys fall back to the same defaults as rho's normalize_state; wrong-typed values fail loudly at the boundary.
const StoredState = Schema.Struct({
  sources: Schema.optional(Schema.Record(Schema.String, SourceEntry)),
  event_rules: Schema.optional(Schema.Array(EventRule)),
  observations: Schema.optional(Schema.Array(Observation)),
  recent_triggers: Schema.optional(Schema.Array(RecentTrigger)),
  desks: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  proactive_counter: Schema.optional(State.fields.proactive_counter),
  attention_policy: Schema.optional(
    Schema.Struct({
      quiet_hours: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean),
          start: Schema.optional(Schema.String),
          end: Schema.optional(Schema.String),
          time_zone: Schema.optional(Schema.String),
        }),
      ),
      daily_proactive_limit: Schema.optional(Schema.Int),
    }),
  ),
})

function normalize(stored: typeof StoredState.Type): State {
  const quiet = stored.attention_policy?.quiet_hours

  return {
    sources: stored.sources ?? {},
    event_rules: stored.event_rules ?? [],
    observations: stored.observations ?? [],
    recent_triggers: stored.recent_triggers ?? [],
    desks: stored.desks ?? {},
    proactive_counter: stored.proactive_counter ?? {},
    attention_policy: {
      quiet_hours: {
        enabled: quiet?.enabled ?? false,
        start: quiet?.start ?? "22:00",
        end: quiet?.end ?? "08:00",
        time_zone: quiet?.time_zone ?? "UTC",
      },
      daily_proactive_limit: stored.attention_policy?.daily_proactive_limit ?? 10,
    },
  }
}

const decodeState = (value: unknown): State => normalize(Schema.decodeUnknownSync(StoredState)(value ?? {}))

export type ChannelAdapter = (message: OutboxMessage) => unknown

const adapters = new Map<string, ChannelAdapter>()

type Gate =
  | { decision: "accept"; strength: "explicit" | "inferred"; matched_rules: EventRule[] }
  | { decision: "observe"; strength: "inferred"; matched_rules: EventRule[] }
  | { decision: "filtered"; strength: "none"; matched_rules: EventRule[] }

export type IngestResult =
  | { outcome: "disabled"; source_key: string }
  | {
      outcome: "observed"
      observation: Observation
      trigger: ExternalTrigger
      fanned_out_conversation_public_ids: string[]
    }
  | { outcome: "filtered" | "fanned_out"; trigger: ExternalTrigger; fanned_out_conversation_public_ids: string[] }
  | {
      outcome: string
      strength: "explicit" | "inferred"
      trigger: ExternalTrigger
      fanned_out_conversation_public_ids: string[]
      routed_conversation_public_id: string | null
    }

export type EnqueueResult =
  | { queued: false; suppressed_reason: string }
  | { queued: true; replayed: boolean; outbox_message: OutboxMessage }

export type DrainSettlement =
  | { public_id: string; outcome: "no_adapter" | "uncertain" | "sent" }
  | { public_id: string; outcome: "dropped"; reason: string }
  | { public_id: string; outcome: "failed"; error?: string }

export type ChannelsOverview = {
  sources: ChannelSource[]
  event_rules: EventRule[]
  attention_policy: AttentionPolicy
  observations: Observation[]
  desks: Record<string, string>
  active_adapters: string[]
}

export class Channels {
  private readonly document: StoreDocument<State>

  constructor(
    store: Client["profile"]["storeEntries"],
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.document = new StoreDocument(store, channelsNamespace, channelsKey, decodeState)
  }

  static registerAdapter(prefix: string, handler: ChannelAdapter) {
    if (!handler) throw new Error("adapter block is required")
    adapters.set(prefix, handler)
  }

  static unregisterAdapter(prefix: string) {
    adapters.delete(prefix)
  }

  static adapterFor(channel_key: string): ChannelAdapter | undefined {
    const exact = adapters.get(channel_key)

    if (exact) return exact
    for (const [prefix, handler] of adapters) {
      if (channel_key === prefix || channel_key.startsWith(prefix + ":")) return handler
    }
    return undefined
  }

  static registeredPrefixes(): string[] {
    return [...adapters.keys()].sort()
  }

  async overview(): Promise<ChannelsOverview> {
    const state = await this.readState()

    return {
      sources: Object.values(state.sources),
      event_rules: [...state.event_rules],
      attention_policy: state.attention_policy,
      observations: [...state.observations],
      desks: state.desks,
      active_adapters: Channels.registeredPrefixes(),
    }
  }

  async sources(): Promise<ChannelSource[]> {
    return Object.values((await this.readState()).sources)
  }

  async upsertSource(input: {
    source_key: string
    name: string
    kind?: string
    enabled?: boolean
    target?: string
    accept_mode?: string
    allowed_senders?: readonly string[]
    allowed_bots?: readonly string[]
  }): Promise<ChannelSource> {
    const key = input.source_key.trim()

    if (!sourceKeyPattern.test(key))
      throw new ChannelsError("source_key must match [a-z0-9][a-z0-9:._-]{0,63}", "channel_source_invalid")

    const name = input.name.trim()

    if (name === "" || Buffer.byteLength(name) > 128)
      throw new ChannelsError("source name is required", "channel_source_invalid")

    const acceptMode = input.accept_mode?.trim() ?? "observe"

    if (!acceptModes.includes(acceptMode))
      throw new ChannelsError("accept_mode must be off, observe or auto", "channel_source_invalid")

    const kind = input.kind?.trim() ?? ""
    const target = input.target?.trim() ?? ""
    const entry: ChannelSource = {
      source_key: key,
      name,
      kind: kind === "" ? "webhook" : kind,
      enabled: input.enabled ?? true,
      target: target === "" ? personalBot : target,
      accept_mode: acceptMode,
      allowed_senders: uniqueClean(input.allowed_senders),
      allowed_bots: uniqueClean(input.allowed_bots),
      updated_at: this.clock().toISOString(),
    }

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)

      return { ...state, sources: { ...state.sources, [key]: entry } }
    })
    return entry
  }

  async removeSource(source_key: string): Promise<ChannelSource> {
    const key = source_key.trim()
    let removed: ChannelSource | undefined

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)
      const sources = { ...state.sources }

      removed = sources[key]
      if (!removed) throw new ChannelsError("No channel source " + key, "channel_source_invalid")
      delete sources[key]
      return { ...state, sources }
    })
    return removed!
  }

  async attentionPolicy(): Promise<AttentionPolicy> {
    return (await this.readState()).attention_policy
  }

  async updateAttentionPolicy(input: {
    quiet_hours?: { enabled?: boolean; start?: string; end?: string; time_zone?: string }
    daily_proactive_limit?: number
  }): Promise<AttentionPolicy> {
    let saved: AttentionPolicy | undefined

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)
      const policy = {
        ...state.attention_policy,
        quiet_hours: { ...state.attention_policy.quiet_hours },
      }

      if (input.quiet_hours) {
        const start = input.quiet_hours.start ?? policy.quiet_hours.start
        const end = input.quiet_hours.end ?? policy.quiet_hours.end

        if (!hhMmPattern.test(start) || !hhMmPattern.test(end))
          throw new ChannelsError("quiet_hours start and end must use HH:MM (24-hour)", "attention_policy_invalid")

        policy.quiet_hours = {
          enabled: input.quiet_hours.enabled ?? policy.quiet_hours.enabled,
          start,
          end,
          time_zone: input.quiet_hours.time_zone ?? policy.quiet_hours.time_zone,
        }
      }
      if (input.daily_proactive_limit !== undefined) {
        if (
          !Number.isInteger(input.daily_proactive_limit) ||
          input.daily_proactive_limit < 1 ||
          input.daily_proactive_limit > 100
        )
          throw new ChannelsError("daily_proactive_limit must be between 1 and 100", "attention_policy_invalid")

        policy.daily_proactive_limit = input.daily_proactive_limit
      }
      saved = policy
      return { ...state, attention_policy: policy }
    })
    return saved!
  }

  async eventRules(): Promise<EventRule[]> {
    return [...(await this.readState()).event_rules]
  }

  async createEventRoutine(input: {
    name: string
    source_key: string
    instructions: string
    pattern?: string
    does?: string
    enabled?: boolean
  }): Promise<EventRule> {
    const now = this.clock().toISOString()
    const entry: EventRule = {
      ...validateEventRule(input),
      public_id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    }

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)

      return { ...state, event_rules: [...state.event_rules, entry] }
    })
    return entry
  }

  async updateEventRoutine(
    public_id: string,
    input: {
      name?: string
      source_key?: string
      instructions?: string
      pattern?: string
      does?: string
      enabled?: boolean
    },
  ): Promise<EventRule> {
    let updated: EventRule | undefined

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)

      if (!state.event_rules.some((rule) => rule.public_id === public_id))
        throw new ChannelsError("No event routine with public id " + public_id, "event_routine_invalid")

      const event_rules = state.event_rules.map((rule) => {
        if (rule.public_id !== public_id) return rule

        const validated = validateEventRule({
          name: input.name ?? rule.name,
          source_key: input.source_key ?? rule.source_key,
          instructions: input.instructions ?? rule.instructions,
          pattern: input.pattern === undefined ? rule.pattern : input.pattern,
          does: input.does ?? rule.does,
          enabled: input.enabled ?? rule.enabled,
        })

        updated = { ...rule, ...validated, updated_at: this.clock().toISOString() }
        return updated
      })

      return { ...state, event_rules }
    })
    return updated!
  }

  async removeEventRoutine(public_id: string): Promise<EventRule> {
    let removed: EventRule | undefined

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)

      removed = state.event_rules.find((rule) => rule.public_id === public_id)
      if (!removed) throw new ChannelsError("No event routine with public id " + public_id, "event_routine_invalid")
      return { ...state, event_rules: state.event_rules.filter((rule) => rule.public_id !== public_id) }
    })
    return removed!
  }

  // The workspace's canonical Personal Desk stays unarchived so WebUI, Personal Reach IM and Triggers share one desk.
  async ensurePersonalDesk(input: {
    client: Client
    workspace_public_id: string
    default_runner_executor_public_id?: string
    owner_speaker_public_id?: string
  }): Promise<Conversation> {
    const workspaceId = input.workspace_public_id.trim()

    if (workspaceId === "") throw new ChannelsError("workspace_public_id is required", "channel_desk_invalid")

    const desired = memoryContext({ audience: "owner", speaker: input.owner_speaker_public_id })
    const workspace = input.client.workspace(workspaceId)
    const existingId = (await this.readState()).desks[workspaceId]

    if (existingId) {
      const door = workspace.conversation(existingId)
      const conversation = await door.fetch().catch((error: unknown) => {
        if (error instanceof NotFound) return undefined
        throw error
      })

      if (conversation && !conversation.archived_at) {
        if (input.owner_speaker_public_id && !isDeepStrictEqual(conversation.memory_context, desired))
          return door.setMemoryContext(desired)
        return conversation
      }
    }

    const created = await workspace.conversations.create(
      {
        title: "Personal Desk",
        metadata: { "opencode.surface": personalDeskSurface, rho_bot_public_id: personalBot },
        default_runner_executor_public_id: input.default_runner_executor_public_id ?? null,
        memory_context: desired,
      },
      { idempotencyKey: "personal-desk:" + workspaceId + ":" + crypto.randomUUID() },
    )

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)

      return { ...state, desks: { ...state.desks, [workspaceId]: created.conversation.public_id } }
    })
    return created.conversation
  }

  // Deterministic Gate: message text never alters permissions, and unowned inferred candidates in
  // observe mode log would_accept without waking the router.
  async ingest(input: {
    client: Client
    workspace_public_id: string
    source_key: string
    external_id: string
    thread_key: string
    text: string
    actor_id?: string
    actor_kind?: string
    addressed?: boolean
    delivery_mode?: "steer" | "steer_now" | "queue"
    payload?: Record<string, unknown>
    model?: string
    default_runner_executor_public_id?: string
    owner_speaker_public_id?: string
  }): Promise<IngestResult> {
    const sourceKey = input.source_key.trim()
    const externalId = input.external_id.trim()
    const threadKey = input.thread_key.trim()

    if (sourceKey === "" || externalId === "" || threadKey === "" || input.text.trim() === "")
      throw new ChannelsError(
        "source_key, external_id, thread_key and non-empty text are required",
        "channel_ingest_invalid",
      )

    const kind = actorKindOf(input.actor_kind)
    const state = await this.readState()
    const source = state.sources[sourceKey] ?? defaultSource(sourceKey)

    if (!source.enabled) return { outcome: "disabled", source_key: sourceKey }

    const gate = evaluateGate({
      source,
      rules: state.event_rules,
      actor_id: input.actor_id,
      actor_kind: kind,
      addressed: input.addressed === true,
      text: input.text,
      thread_key: threadKey,
    })
    const workspace = input.client.workspace(input.workspace_public_id)
    const trigger: IngestTrigger = {
      source_key: sourceKey,
      external_id: externalId,
      thread_key: threadKey,
      text: input.text,
      actor_id: input.actor_id,
      actor_kind: kind,
      addressed: false,
      payload: input.payload ?? {},
    }

    if (gate.decision === "observe") {
      const observation = await this.recordObservation({
        source_key: sourceKey,
        external_id: externalId,
        thread_key: threadKey,
        decision: "would_accept",
        matched_rules: gate.matched_rules.map((rule) => rule.name),
        preview: Array.from(input.text).slice(0, 180).join(""),
      })
      const fanned = await workspace.triggers.create(trigger)

      return {
        outcome: "observed",
        observation,
        trigger: fanned.trigger,
        fanned_out_conversation_public_ids: fanned.fanned_out_conversation_public_ids,
      }
    }
    if (gate.decision === "filtered") {
      const fanned = await workspace.triggers.create(trigger)

      return {
        outcome: fanned.fanned_out_conversation_public_ids.length === 0 ? "filtered" : "fanned_out",
        trigger: fanned.trigger,
        fanned_out_conversation_public_ids: fanned.fanned_out_conversation_public_ids,
      }
    }

    const desk = await this.ensurePersonalDesk({
      client: input.client,
      workspace_public_id: input.workspace_public_id,
      default_runner_executor_public_id: input.default_runner_executor_public_id,
      owner_speaker_public_id: input.owner_speaker_public_id,
    })
    const ingested = await workspace.triggers.create({
      ...trigger,
      text: decorateTriggerText(input.text, sourceKey, threadKey, externalId, gate),
      addressed: true,
      delivery_mode: input.delivery_mode,
      router_conversation_public_id: desk.public_id,
      model: input.model,
    })

    await this.rememberTrigger({
      source_key: sourceKey,
      thread_key: threadKey,
      external_id: externalId,
      trigger_public_id: ingested.trigger.public_id,
    })
    return {
      outcome: ingested.outcome,
      strength: gate.strength,
      trigger: ingested.trigger,
      fanned_out_conversation_public_ids: ingested.fanned_out_conversation_public_ids,
      routed_conversation_public_id: ingested.routed_conversation_public_id,
    }
  }

  async resolveTriggerPublicId(input: {
    trigger_public_id?: string
    source_key?: string
    thread_key?: string
    external_id?: string
  }): Promise<string | null> {
    const candidate = input.trigger_public_id?.trim() ?? ""

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) return candidate

    const recent = (await this.readState()).recent_triggers
    const externalId = input.external_id?.trim() ?? ""

    if (externalId !== "") {
      const found = recent.find(
        (row) => row.external_id === externalId && (!input.source_key || row.source_key === input.source_key),
      )

      if (found) return found.trigger_public_id
    }
    if (candidate !== "" && candidate !== "latest") {
      const found = recent.find((row) => row.external_id === candidate)

      if (found) return found.trigger_public_id
    }
    if (input.source_key && input.thread_key) {
      const latest = recent.find((row) => row.source_key === input.source_key && row.thread_key === input.thread_key)

      if (latest) return latest.trigger_public_id
    }
    return recent[0]?.trigger_public_id ?? null
  }

  // Enqueue a 4-purpose reply onto the durable Outbox, honoring quiet hours and the daily
  // proactive cap for unsolicited acknowledgement/result updates.
  async enqueueReply(input: {
    client: Client
    workspace_public_id: string
    channel_key: string
    thread_key: string
    body: string
    purpose?: string
    conversation_public_id?: string
    proactive?: boolean
    metadata?: Record<string, unknown>
    idempotency_key?: string
  }): Promise<EnqueueResult> {
    const purpose = replyPurposeOf(input.purpose)
    const body = input.body.trim()

    if (body === "") throw new ChannelsError("reply body is required", "channel_reply_invalid")

    if (input.proactive === true && (purpose === "acknowledgement" || purpose === "result")) {
      const refusal = await this.proactiveRefusal()

      if (refusal) return { queued: false, suppressed_reason: refusal }
    }

    const created = await input.client.workspace(input.workspace_public_id).outboxMessages.create(
      {
        channel_key: input.channel_key.trim(),
        thread_key: input.thread_key.trim(),
        body,
        purpose,
        conversation_public_id: input.conversation_public_id,
        metadata: input.metadata ?? {},
      },
      { idempotencyKey: input.idempotency_key ?? crypto.randomUUID() },
    )

    if (input.proactive === true && !created.replayed) await this.recordProactiveSend()
    return { queued: true, replayed: created.replayed, outbox_message: created.outbox_message }
  }

  // Lease-claim due Outbox rows and dispatch through registered adapters; an uncertain
  // verdict leaves the lease untouched rather than blind-retrying an unconfirmed send.
  async drainOutbox(input: {
    client: Client
    workspace_public_id: string
    channel_key?: string
    limit?: number
    lease_seconds?: number
  }): Promise<DrainSettlement[]> {
    const outbox = input.client.workspace(input.workspace_public_id).outboxMessages
    const claimed = await outbox.claim({
      channel_key: input.channel_key,
      limit: input.limit ?? 20,
      lease_seconds: input.lease_seconds ?? 30,
    })
    const results: DrainSettlement[] = []

    for (const message of claimed) {
      const adapter = Channels.adapterFor(message.channel_key)

      if (!adapter) {
        results.push({ public_id: message.public_id, outcome: "no_adapter" })
        continue
      }

      const verdict = await adapter(message)
      const pair = Array.isArray(verdict) && verdict.length === 2 ? verdict : undefined

      if (verdict === "sent" || pair?.[0] === "sent") {
        const settled = await outbox.settle(message.public_id, { action: "sent" })

        results.push({ public_id: settled.public_id, outcome: "sent" })
        continue
      }
      if (pair?.[0] === "dropped") {
        const reason = String(pair[1])
        const settled = await outbox.settle(message.public_id, { action: "dropped", reason })

        results.push({ public_id: settled.public_id, outcome: "dropped", reason })
        continue
      }
      if (verdict === "dropped") {
        const settled = await outbox.settle(message.public_id, { action: "dropped", reason: "channel_gone" })

        results.push({ public_id: settled.public_id, outcome: "dropped", reason: "channel_gone" })
        continue
      }
      if (pair?.[0] === "failed") {
        const error = String(pair[1])
        const settled = await outbox.settle(message.public_id, { action: "failed", error })

        results.push({ public_id: settled.public_id, outcome: "failed", error })
        continue
      }
      if (verdict === "uncertain") {
        results.push({ public_id: message.public_id, outcome: "uncertain" })
        continue
      }

      const settled = await outbox.settle(message.public_id, { action: "failed", error: "unexpected_adapter_outcome" })

      results.push({ public_id: settled.public_id, outcome: "failed" })
    }
    return results
  }

  private async readState(): Promise<State> {
    return (await this.document.read()) ?? decodeState(null)
  }

  private async recordObservation(input: {
    source_key: string
    external_id: string
    thread_key: string
    decision: string
    matched_rules: string[]
    preview: string
  }): Promise<Observation> {
    const entry: Observation = { public_id: crypto.randomUUID(), ...input, observed_at: this.clock().toISOString() }

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)

      return { ...state, observations: [entry, ...state.observations].slice(0, maxObservations) }
    })
    return entry
  }

  private async rememberTrigger(input: {
    source_key: string
    thread_key: string
    external_id: string
    trigger_public_id: string
  }): Promise<void> {
    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)
      const seen = new Set<string>()
      const recent_triggers = [input, ...state.recent_triggers]
        .filter((row) => {
          if (seen.has(row.trigger_public_id)) return false
          seen.add(row.trigger_public_id)
          return true
        })
        .slice(0, maxObservations)

      return { ...state, recent_triggers }
    })
  }

  private async proactiveRefusal(): Promise<string | undefined> {
    const state = await this.readState()
    const policy = state.attention_policy
    const now = this.clock()

    if (
      policy.quiet_hours.enabled &&
      withinQuietHours(now, policy.quiet_hours.start, policy.quiet_hours.end, policy.quiet_hours.time_zone)
    )
      return "quiet_hours"

    const today = now.toISOString().slice(0, 10)
    const sent = state.proactive_counter.date === today ? (state.proactive_counter.count ?? 0) : 0

    if (sent >= policy.daily_proactive_limit) return "daily_limit_exceeded"
    return undefined
  }

  private async recordProactiveSend(): Promise<void> {
    const today = this.clock().toISOString().slice(0, 10)

    await changeDocument(this.document, (current) => {
      const state = current ?? decodeState(null)
      const count = state.proactive_counter.date === today ? (state.proactive_counter.count ?? 0) + 1 : 1

      return { ...state, proactive_counter: { date: today, count } }
    })
  }
}

function defaultSource(source_key: string): ChannelSource {
  return {
    source_key,
    name: source_key,
    kind: source_key.startsWith("telegram") ? "telegram" : "webhook",
    enabled: true,
    target: personalBot,
    accept_mode: "observe",
    allowed_senders: [],
    allowed_bots: [],
  }
}

function evaluateGate(input: {
  source: ChannelSource
  rules: readonly EventRule[]
  actor_id?: string
  actor_kind: "human" | "bot" | "system"
  addressed: boolean
  text: string
  thread_key: string
}): Gate {
  const senders = input.source.allowed_senders
  const bots = input.source.allowed_bots
  const senderAllowed =
    senders.length === 0 || (input.actor_id !== undefined && input.actor_id !== "" && senders.includes(input.actor_id))

  if (input.actor_kind === "human" && input.addressed && senderAllowed)
    return { decision: "accept", strength: "explicit", matched_rules: [] }
  if (input.source.accept_mode === "off") return { decision: "filtered", strength: "none", matched_rules: [] }
  if (input.actor_kind === "bot" && bots.length > 0 && !bots.includes(input.actor_id ?? ""))
    return { decision: "filtered", strength: "none", matched_rules: [] }

  const matching = input.rules.filter(
    (rule) =>
      rule.enabled &&
      (rule.source_key === "*" || rule.source_key === input.source.source_key) &&
      ruleMatches(rule.pattern, input.text, input.thread_key),
  )

  if (matching.length === 0) return { decision: "filtered", strength: "none", matched_rules: [] }
  if (input.source.accept_mode === "observe")
    return { decision: "observe", strength: "inferred", matched_rules: matching }
  return { decision: "accept", strength: "inferred", matched_rules: matching }
}

function ruleMatches(pattern: string | undefined, text: string, thread_key: string): boolean {
  if (pattern === undefined || pattern.trim() === "") return true

  const needle = pattern.toLowerCase()

  return text.toLowerCase().includes(needle) || thread_key.toLowerCase().includes(needle)
}

function decorateTriggerText(
  text: string,
  source_key: string,
  thread_key: string,
  external_id: string,
  gate: Gate,
): string {
  const header = `[Source: ${source_key} · Thread: ${thread_key} · ExternalID: ${external_id} · Strength: ${gate.strength}]`

  if (gate.matched_rules.length === 0) return header + "\n" + text

  const directives = gate.matched_rules
    .map((rule) => {
      const note =
        rule.does === "check_in" ? "(Check-in only: stay silent unless action is needed)" : "(Act within approvals)"

      return `- Rule ${rule.name} ${note}: ${rule.instructions}`
    })
    .join("\n")

  return `${header}\nMatched proactive rules:\n${directives}\n\n${text}`
}

function validateEventRule(input: {
  name: string
  source_key: string
  instructions: string
  pattern?: string
  does?: string
  enabled?: boolean
}): { name: string; source_key: string; pattern?: string; instructions: string; does: string; enabled: boolean } {
  const name = input.name.trim()

  if (name === "" || Buffer.byteLength(name) > 128)
    throw new ChannelsError("routine name is required (max 128 bytes)", "event_routine_invalid")

  const sourceKey = input.source_key.trim()

  if (sourceKey !== "*" && !sourceKeyPattern.test(sourceKey))
    throw new ChannelsError("source_key must be * or a valid source identifier", "event_routine_invalid")

  const instructions = input.instructions.trim()

  if (instructions === "" || Buffer.byteLength(instructions) > 8192)
    throw new ChannelsError("instructions are required (max 8192 bytes)", "event_routine_invalid")

  const does = input.does?.trim() ?? "act"

  if (!doesModes.includes(does)) throw new ChannelsError("does must be act or check_in", "event_routine_invalid")

  const pattern = input.pattern?.trim() ?? ""
  const row: { name: string; source_key: string; pattern?: string; instructions: string; does: string; enabled: boolean } = {
    name,
    source_key: sourceKey,
    instructions,
    does,
    enabled: input.enabled ?? true,
  }

  if (pattern !== "") row.pattern = pattern
  return row
}

function actorKindOf(value: string | undefined): "human" | "bot" | "system" {
  const kind = value?.trim() ?? ""

  if (kind === "" || kind === "human") return "human"
  if (kind === "bot" || kind === "system") return kind
  throw new ChannelsError("actor_kind must be human, bot or system", "channel_ingest_invalid")
}

function replyPurposeOf(value: string | undefined): "acknowledgement" | "answer" | "attention" | "result" {
  const purpose = value === undefined ? "result" : value.trim()

  if (purpose === "acknowledgement" || purpose === "answer" || purpose === "attention" || purpose === "result")
    return purpose
  throw new ChannelsError("purpose must be acknowledgement, answer, attention or result", "channel_reply_invalid")
}

function uniqueClean(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value !== ""))]
}

// Quiet hours compare HH:MM wall-clock strings in the configured zone, so overnight
// windows (start > end) wrap across midnight. An unparseable zone falls back to UTC.
function withinQuietHours(now: Date, start: string, end: string, timeZone: string): boolean {
  const current = localHHMM(now, timeZone)

  if (start <= end) return current >= start && current < end
  return current >= start || current < end
}

function localHHMM(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      now,
    )
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now)
  }
}
