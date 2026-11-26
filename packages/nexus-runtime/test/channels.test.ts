import { afterEach, expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { Channels, ChannelsError } from "../src/channels"
import { storeFixture } from "./fixture/store"
import { conversationFixture } from "./fixture/conversation"

function outboxRow(fields: JsonObject): JsonObject {
  return {
    public_id: "out-x",
    conversation_public_id: null,
    channel_key: "telegram:conn-1",
    thread_key: "t1",
    purpose: "result",
    status: "pending",
    body: "ok",
    metadata: {},
    attempts_count: 0,
    last_error: null,
    dropped_reason: null,
    next_attempt_at: null,
    sent_at: null,
    dropped_at: null,
    created_at: new Date().toISOString(),
    ...fields,
  }
}

function channelFixture(fault?: (request: Request) => Response | undefined) {
  const calls = {
    triggers: [] as JsonObject[],
    created: [] as JsonObject[],
    idempotencyKeys: [] as string[],
    memoryContexts: [] as JsonObject[],
    outbox: [] as JsonObject[],
    claims: [] as JsonObject[],
    settlements: [] as [string, JsonObject][],
  }
  const conversations = new Map<string, JsonObject>()
  const outboxByKey = new Map<string, JsonObject>()
  const state = { fannedOut: [] as string[], claimable: [] as JsonObject[] }

  const fixture = storeFixture(async (request) => {
    const injected = fault?.(request)

    if (injected) return injected

    const url = new URL(request.url)
    const path = url.pathname

    if (path.includes("/store_entries")) return

    if (path.endsWith("/triggers") && request.method === "POST") {
      const input = (await request.json()) as { trigger: JsonObject }

      calls.triggers.push(input.trigger)
      return Response.json({
        outcome: "stored",
        trigger: {
          public_id: "trig-" + calls.triggers.length,
          source_key: input.trigger.source_key,
          external_id: input.trigger.external_id,
          thread_key: input.trigger.thread_key,
          actor_id: input.trigger.actor_id ?? null,
          actor_kind: input.trigger.actor_kind ?? "human",
          addressed: input.trigger.addressed ?? false,
          disposition: {},
          created_at: new Date().toISOString(),
        },
        fanned_out_conversation_public_ids: state.fannedOut,
        routed_conversation_public_id: input.trigger.router_conversation_public_id ?? null,
      })
    }

    if (path.endsWith("/conversations") && request.method === "POST") {
      const input = (await request.json()) as { conversation: JsonObject }
      const id = crypto.randomUUID()

      conversations.set(
        id,
        conversationFixture({ ...input.conversation, public_id: id, workspace_public_id: path.split("/").at(-2)! }),
      )
      calls.created.push(input.conversation)
      calls.idempotencyKeys.push(request.headers.get("idempotency-key")!)
      return Response.json({ conversation: conversations.get(id) }, { status: 201 })
    }

    if (path.includes("/conversations/")) {
      const id = path.split("/").at(path.endsWith("/memory_context") ? -2 : -1)!
      const conversation = conversations.get(id)

      if (!conversation) return Response.json({ error: { code: "not_found" } }, { status: 404 })
      if (path.endsWith("/memory_context") && request.method === "POST") {
        const input = (await request.json()) as { memory_context: JsonObject }

        conversation.memory_context = input.memory_context
        calls.memoryContexts.push(input)
      }
      return Response.json({ conversation })
    }

    if (path.endsWith("/outbox_messages/claim") && request.method === "POST") {
      const input = (await request.json()) as { claim: JsonObject }
      const rows = state.claimable

      calls.claims.push(input.claim)
      state.claimable = []
      return Response.json({ outbox_messages: rows })
    }

    if (path.endsWith("/settlement") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const input = (await request.json()) as { settlement: JsonObject }

      calls.settlements.push([id, input.settlement])
      return Response.json({
        outbox_message: outboxRow({
          public_id: id,
          status: input.settlement.action === "failed" ? "pending" : input.settlement.action,
        }),
      })
    }

    if (path.endsWith("/outbox_messages") && request.method === "POST") {
      const input = (await request.json()) as { outbox_message: JsonObject }
      const key = request.headers.get("idempotency-key")!
      const existing = outboxByKey.get(key)

      if (existing)
        return Response.json(
          { outbox_message: existing },
          { status: 200, headers: { "Idempotency-Replayed": "true" } },
        )

      const row = outboxRow({ public_id: "out-" + (outboxByKey.size + 1), ...input.outbox_message })

      outboxByKey.set(key, row)
      calls.outbox.push(input.outbox_message)
      return Response.json({ outbox_message: row }, { status: 201 })
    }

    return Response.json({ error: { code: "not_found" } }, { status: 404 })
  })

  return { fixture, calls, conversations, state }
}

afterEach(() => {
  for (const prefix of Channels.registeredPrefixes()) Channels.unregisterAdapter(prefix)
})

test("gate distinguishes explicit, observe and auto proactive rules", async () => {
  const { fixture, calls } = channelFixture()
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    await channels.upsertSource({
      source_key: "github",
      name: "GitHub",
      accept_mode: "observe",
      allowed_senders: ["alice"],
    })
    await channels.createEventRoutine({
      name: "CI Failure Triage",
      source_key: "github",
      pattern: "ci failed",
      instructions: "Inspect failing workflow logs.",
      does: "check_in",
    })

    const observed = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "github",
      external_id: "evt-1",
      thread_key: "pr-12",
      text: "CI failed on main build",
      actor_id: "actions-bot",
      actor_kind: "bot",
      addressed: false,
    })

    expect(observed.outcome).toBe("observed")
    if (!("observation" in observed)) throw new Error("expected observed")
    expect(observed.observation.matched_rules).toEqual(["CI Failure Triage"])
    expect(observed.observation.decision).toBe("would_accept")
    expect(observed.observation.preview).toBe("CI failed on main build")
    expect(calls.created).toHaveLength(0)
    expect(calls.triggers.at(-1)).toMatchObject({ addressed: false, actor_kind: "bot" })
    expect(calls.triggers.at(-1)?.router_conversation_public_id).toBeUndefined()
    expect(calls.triggers.at(-1)?.delivery_mode).toBeUndefined()
    expect(calls.triggers.at(-1)?.model).toBeUndefined()

    const explicit = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "github",
      external_id: "evt-2",
      thread_key: "pr-12",
      text: "@rho please review this PR",
      actor_id: "alice",
      actor_kind: "human",
      addressed: true,
    })

    expect(explicit.outcome).toBe("stored")
    if (explicit.outcome !== "stored") throw new Error("expected stored")
    expect(explicit.strength).toBe("explicit")
    expect(explicit.routed_conversation_public_id).toBeString()
    expect(calls.created).toHaveLength(1)
    expect(calls.created[0]).toMatchObject({
      title: "Personal Desk",
      metadata: { "opencode.surface": "personal_desk", rho_bot_public_id: "personal" },
    })
    expect(calls.created[0]?.memory_context).toMatchObject({ mode: "index" })
    expect(calls.idempotencyKeys[0]).toStartWith("personal-desk:ws-1:")
    expect(calls.triggers.at(-1)).toMatchObject({ addressed: true, actor_kind: "human", actor_id: "alice" })
    expect(calls.triggers.at(-1)?.text).toBe(
      "[Source: github · Thread: pr-12 · ExternalID: evt-2 · Strength: explicit]\n@rho please review this PR",
    )

    await channels.upsertSource({
      source_key: "github",
      name: "GitHub",
      accept_mode: "auto",
      allowed_senders: ["alice"],
    })
    const auto = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "github",
      external_id: "evt-3",
      thread_key: "pr-99",
      text: "CI failed on release branch",
      actor_id: "actions-bot",
      actor_kind: "bot",
      addressed: false,
    })

    expect(auto.outcome).toBe("stored")
    if (auto.outcome !== "stored") throw new Error("expected stored")
    expect(auto.strength).toBe("inferred")
    expect(calls.triggers.at(-1)?.text).toBe(
      "[Source: github · Thread: pr-99 · ExternalID: evt-3 · Strength: inferred]\n" +
        "Matched proactive rules:\n" +
        "- Rule CI Failure Triage (Check-in only: stay silent unless action is needed): Inspect failing workflow logs.\n" +
        "\n" +
        "CI failed on release branch",
    )

    const overview = await channels.overview()

    expect(overview.observations).toHaveLength(1)
    expect(overview.desks["ws-1"]).toBeString()
    expect(overview.active_adapters).toEqual([])
  } finally {
    fixture.server.stop(true)
  }
})

test("outbox respects quiet hours, daily budget and uncertain adapter non-retry", async () => {
  const { fixture, calls, state } = channelFixture()
  const now = { at: new Date("2026-11-26T14:00:00Z") }
  const channels = new Channels(fixture.client.profile.storeEntries, () => now.at)

  try {
    await channels.updateAttentionPolicy({
      quiet_hours: { enabled: true, start: "22:00", end: "08:00", time_zone: "UTC" },
      daily_proactive_limit: 1,
    })

    now.at = new Date("2026-11-26T23:00:00Z")
    const suppressed = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Nightly check",
      purpose: "result",
      proactive: true,
    })

    expect(suppressed).toEqual({ queued: false, suppressed_reason: "quiet_hours" })
    expect(calls.outbox).toHaveLength(0)

    const direct = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Direct answer",
      purpose: "answer",
      proactive: false,
    })

    expect(direct.queued).toBe(true)
    if (!direct.queued) throw new Error("expected queued")
    expect(direct.replayed).toBe(false)
    expect(calls.outbox.at(-1)).toMatchObject({ body: "Direct answer", purpose: "answer" })

    now.at = new Date("2026-11-27T10:00:00Z")
    const first = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Morning brief",
      purpose: "result",
      proactive: true,
    })

    expect(first.queued).toBe(true)

    const capped = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Extra ping",
      purpose: "result",
      proactive: true,
    })

    expect(capped).toEqual({ queued: false, suppressed_reason: "daily_limit_exceeded" })

    state.claimable = [
      outboxRow({ public_id: "m1", thread_key: "t1", body: "ok" }),
      outboxRow({ public_id: "m2", thread_key: "t2", body: "gone" }),
      outboxRow({ public_id: "m3", thread_key: "t3", body: "net_drop" }),
    ]
    Channels.registerAdapter("telegram", (message) => {
      if (message.body === "ok") return "sent"
      if (message.body === "gone") return ["dropped", "channel_gone"]
      return "uncertain"
    })

    const drained = await channels.drainOutbox({ client: fixture.client, workspace_public_id: "ws-1" })

    expect(drained.map((row) => row.outcome)).toEqual(["sent", "dropped", "uncertain"])
    expect(calls.settlements).toEqual([
      ["m1", { action: "sent" }],
      ["m2", { action: "dropped", reason: "channel_gone" }],
    ])
    expect(calls.claims[0]).toEqual({ limit: 20, lease_seconds: 30 })
  } finally {
    fixture.server.stop(true)
  }
})

test("sources, event routines and attention policy validate and mutate the document", async () => {
  const { fixture } = channelFixture()
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    await expect(channels.upsertSource({ source_key: "GitHub!", name: "GitHub" })).rejects.toThrow(
      "source_key must match [a-z0-9][a-z0-9:._-]{0,63}",
    )
    await expect(channels.upsertSource({ source_key: "github", name: "" })).rejects.toThrow("source name is required")
    await expect(
      channels.upsertSource({ source_key: "github", name: "GitHub", accept_mode: "loud" }),
    ).rejects.toThrow("accept_mode must be off, observe or auto")
    await expect(channels.removeSource("github")).rejects.toThrow("No channel source github")

    await channels.upsertSource({ source_key: "github", name: "GitHub" })

    const source = await channels.upsertSource({
      source_key: "telegram:conn-1",
      name: " Telegram ",
      allowed_senders: [" alice ", "", "alice"],
      allowed_bots: ["rho-bot"],
    })

    expect(source).toMatchObject({
      source_key: "telegram:conn-1",
      name: "Telegram",
      kind: "webhook",
      enabled: true,
      target: "personal",
      accept_mode: "observe",
      allowed_senders: ["alice"],
      allowed_bots: ["rho-bot"],
    })
    expect(source.updated_at).toBeString()
    expect((await channels.sources()).map((row) => row.source_key)).toEqual(["github", "telegram:conn-1"])

    await channels.upsertSource({ source_key: "telegram:conn-1", name: "Telegram", kind: "telegram" })
    expect((await channels.sources()).find((row) => row.source_key === "telegram:conn-1")?.kind).toBe("telegram")

    const removed = await channels.removeSource("github")

    expect(removed.source_key).toBe("github")
    expect((await channels.sources()).map((row) => row.source_key)).toEqual(["telegram:conn-1"])

    await expect(
      channels.createEventRoutine({ name: "", source_key: "*", instructions: "Do it" }),
    ).rejects.toThrow("routine name is required (max 128 bytes)")
    await expect(
      channels.createEventRoutine({ name: "x".repeat(129), source_key: "*", instructions: "Do it" }),
    ).rejects.toThrow("routine name is required (max 128 bytes)")
    await expect(
      channels.createEventRoutine({ name: "Watch", source_key: "Bad Key", instructions: "Do it" }),
    ).rejects.toThrow("source_key must be * or a valid source identifier")
    await expect(
      channels.createEventRoutine({ name: "Watch", source_key: "*", instructions: "" }),
    ).rejects.toThrow("instructions are required (max 8192 bytes)")
    await expect(
      channels.createEventRoutine({ name: "Watch", source_key: "*", instructions: "Do it", does: "maybe" }),
    ).rejects.toThrow("does must be act or check_in")

    const rule = await channels.createEventRoutine({
      name: "PR Watch",
      source_key: "github",
      instructions: "Inspect PR diff.",
      pattern: "  review_requested ",
    })

    expect(rule).toMatchObject({
      name: "PR Watch",
      source_key: "github",
      pattern: "review_requested",
      does: "act",
      enabled: true,
    })
    expect(rule.public_id).toBeString()
    expect(rule.created_at).toBeString()

    const wildcard = await channels.createEventRoutine({ name: "Any", source_key: "*", instructions: "Note it" })

    expect(wildcard.pattern).toBeUndefined()

    const renamed = await channels.updateEventRoutine(rule.public_id, { name: "PR Watch v2" })

    expect(renamed).toMatchObject({ name: "PR Watch v2", pattern: "review_requested", does: "act" })
    expect(renamed.updated_at >= rule.updated_at).toBe(true)

    const cleared = await channels.updateEventRoutine(rule.public_id, { pattern: "" })

    expect(cleared.pattern).toBe("review_requested")

    const repatterned = await channels.updateEventRoutine(rule.public_id, { pattern: "ci failed", does: "check_in" })

    expect(repatterned).toMatchObject({ pattern: "ci failed", does: "check_in" })
    await expect(channels.updateEventRoutine("missing", { name: "x" })).rejects.toThrow(
      "No event routine with public id missing",
    )
    await expect(channels.removeEventRoutine("missing")).rejects.toThrow("No event routine with public id missing")

    const removedRule = await channels.removeEventRoutine(wildcard.public_id)

    expect(removedRule.public_id).toBe(wildcard.public_id)
    expect((await channels.eventRules()).map((row) => row.public_id)).toEqual([rule.public_id])

    await expect(
      channels.updateAttentionPolicy({ quiet_hours: { start: "9:00" } }),
    ).rejects.toThrow("quiet_hours start and end must use HH:MM (24-hour)")
    await expect(channels.updateAttentionPolicy({ daily_proactive_limit: 0 })).rejects.toThrow(
      "daily_proactive_limit must be between 1 and 100",
    )
    await expect(channels.updateAttentionPolicy({ daily_proactive_limit: 101 })).rejects.toThrow(
      "daily_proactive_limit must be between 1 and 100",
    )

    const policy = await channels.updateAttentionPolicy({ daily_proactive_limit: 3 })

    expect(policy).toEqual({
      quiet_hours: { enabled: false, start: "22:00", end: "08:00", time_zone: "UTC" },
      daily_proactive_limit: 3,
    })

    const quiet = await channels.updateAttentionPolicy({
      quiet_hours: { enabled: true, start: "21:30", time_zone: "Australia/Perth" },
    })

    expect(quiet).toEqual({
      quiet_hours: { enabled: true, start: "21:30", end: "08:00", time_zone: "Australia/Perth" },
      daily_proactive_limit: 3,
    })
    expect(await channels.attentionPolicy()).toEqual(quiet)

    const sourceError = await channels.upsertSource({ source_key: "!", name: "x" }).catch((error) => error)

    expect(sourceError).toBeInstanceOf(ChannelsError)
    expect((sourceError as ChannelsError).code).toBe("channel_source_invalid")

    const policyError = await channels.updateAttentionPolicy({ daily_proactive_limit: 0 }).catch((error) => error)

    expect((policyError as ChannelsError).code).toBe("attention_policy_invalid")
  } finally {
    fixture.server.stop(true)
  }
})

test("ingest filters disabled, off-mode, unlisted bots and unmatched sources", async () => {
  const { fixture, calls, state } = channelFixture()
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    await channels.upsertSource({ source_key: "paused", name: "Paused", enabled: false })

    const disabled = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "paused",
      external_id: "evt-0",
      thread_key: "t-0",
      text: "Anything",
    })

    expect(disabled).toEqual({ outcome: "disabled", source_key: "paused" })
    expect(calls.triggers).toHaveLength(0)

    await expect(
      channels.ingest({
        client: fixture.client,
        workspace_public_id: "ws-1",
        source_key: "github",
        external_id: "evt-1",
        thread_key: "t-1",
        text: "   ",
      }),
    ).rejects.toThrow("source_key, external_id, thread_key and non-empty text are required")
    await expect(
      channels.ingest({
        client: fixture.client,
        workspace_public_id: "ws-1",
        source_key: "github",
        external_id: "evt-1",
        thread_key: "t-1",
        text: "Hello",
        actor_kind: "alien",
      }),
    ).rejects.toThrow("actor_kind must be human, bot or system")

    await channels.upsertSource({ source_key: "quiet", name: "Quiet", accept_mode: "off", allowed_senders: ["alice"] })

    const filtered = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "quiet",
      external_id: "evt-1",
      thread_key: "t-1",
      text: "CI failed",
      actor_id: "bob",
      addressed: true,
    })

    expect(filtered.outcome).toBe("filtered")
    expect(calls.triggers.at(-1)?.router_conversation_public_id).toBeUndefined()

    const explicitOff = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "quiet",
      external_id: "evt-2",
      thread_key: "t-1",
      text: "@rho still listen to me",
      actor_id: "alice",
      addressed: true,
    })

    expect(explicitOff.outcome).toBe("stored")
    if (explicitOff.outcome !== "stored") throw new Error("expected stored")
    expect(explicitOff.strength).toBe("explicit")

    state.fannedOut = ["conv-subscribed"]

    const fanned = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "unknown-hook",
      external_id: "evt-3",
      thread_key: "t-3",
      text: "No rules anywhere",
    })

    expect(fanned.outcome).toBe("fanned_out")
    if (fanned.outcome !== "fanned_out") throw new Error("expected fanned_out")
    expect(fanned.fanned_out_conversation_public_ids).toEqual(["conv-subscribed"])

    state.fannedOut = []
    await channels.upsertSource({
      source_key: "bots-only",
      name: "Bots",
      accept_mode: "auto",
      allowed_bots: ["rho-bot"],
    })
    await channels.createEventRoutine({ name: "Any", source_key: "bots-only", instructions: "Note it" })

    const unlisted = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "bots-only",
      external_id: "evt-4",
      thread_key: "t-4",
      text: "Anything from a stranger bot",
      actor_id: "stranger",
      actor_kind: "bot",
    })

    expect(unlisted.outcome).toBe("filtered")

    const listed = await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "bots-only",
      external_id: "evt-5",
      thread_key: "t-5",
      text: "Anything from our bot",
      actor_id: "rho-bot",
      actor_kind: "bot",
    })

    expect(listed.outcome).toBe("stored")
    if (listed.outcome !== "stored") throw new Error("expected stored")
    expect(listed.strength).toBe("inferred")
  } finally {
    fixture.server.stop(true)
  }
})

test("resolve_trigger_public_id accepts UUIDs and looks up recent triggers", async () => {
  const { fixture } = channelFixture()
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    expect(await channels.resolveTriggerPublicId({})).toBeNull()

    await channels.ingest({
      client: fixture.client,
      workspace_public_id: "ws-1",
      source_key: "github",
      external_id: "evt-42",
      thread_key: "pr-7",
      text: "@rho look",
      actor_id: "alice",
      addressed: true,
    })

    const uuid = "550e8400-e29b-41d4-a716-446655440000"

    expect(await channels.resolveTriggerPublicId({ trigger_public_id: uuid })).toBe(uuid)
    expect(await channels.resolveTriggerPublicId({ external_id: "evt-42" })).toBe("trig-1")
    expect(await channels.resolveTriggerPublicId({ external_id: "evt-42", source_key: "other" })).toBe("trig-1")
    expect(await channels.resolveTriggerPublicId({ trigger_public_id: "evt-42" })).toBe("trig-1")
    expect(await channels.resolveTriggerPublicId({ source_key: "github", thread_key: "pr-7" })).toBe("trig-1")
    expect(await channels.resolveTriggerPublicId({})).toBe("trig-1")
    expect(await channels.resolveTriggerPublicId({ trigger_public_id: "latest" })).toBe("trig-1")
  } finally {
    fixture.server.stop(true)
  }
})

test("adapter registry matches exact keys and prefixes", () => {
  const exact = () => "sent"
  const prefixed = () => "dropped"

  Channels.registerAdapter("telegram", prefixed)
  Channels.registerAdapter("telegram:conn-1", exact)

  expect(Channels.adapterFor("telegram:conn-1")).toBe(exact)
  expect(Channels.adapterFor("telegram:conn-2")).toBe(prefixed)
  expect(Channels.adapterFor("telegram")).toBe(prefixed)
  expect(Channels.adapterFor("slack:conn-1")).toBeUndefined()
  expect(Channels.registeredPrefixes()).toEqual(["telegram", "telegram:conn-1"])

  Channels.unregisterAdapter("telegram:conn-1")
  expect(Channels.adapterFor("telegram:conn-1")).toBe(prefixed)
})

test("ensure_personal_desk reuses, repairs and recreates the desk", async () => {
  const { fixture, calls, conversations } = channelFixture()
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    await expect(channels.ensurePersonalDesk({ client: fixture.client, workspace_public_id: " " })).rejects.toThrow(
      "workspace_public_id is required",
    )

    const first = await channels.ensurePersonalDesk({
      client: fixture.client,
      workspace_public_id: "ws-1",
      default_runner_executor_public_id: "run-exec-1",
      owner_speaker_public_id: "owner-a",
    })

    expect(first.title).toBe("Personal Desk")
    expect(calls.created[0]).toMatchObject({
      title: "Personal Desk",
      metadata: { "opencode.surface": "personal_desk", rho_bot_public_id: "personal" },
      default_runner_executor_public_id: "run-exec-1",
      memory_context: {
        bindings: [
          { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
          { name: "speaker", source: { scope: "speaker", speaker_public_id: "owner-a" }, access: "read_write" },
          { name: "agent", source: { scope: "agent" }, access: "read_write" },
          { name: "workspace", source: { scope: "workspace" }, access: "read_write" },
        ],
        mode: "index",
      },
    })
    expect(calls.idempotencyKeys[0]).toStartWith("personal-desk:ws-1:")

    const again = await channels.ensurePersonalDesk({ client: fixture.client, workspace_public_id: "ws-1" })

    expect(again.public_id).toBe(first.public_id)
    expect(calls.created).toHaveLength(1)
    expect(calls.memoryContexts).toHaveLength(0)

    const repaired = await channels.ensurePersonalDesk({
      client: fixture.client,
      workspace_public_id: "ws-1",
      owner_speaker_public_id: "owner-b",
    })

    expect(repaired.public_id).toBe(first.public_id)
    expect(calls.memoryContexts).toHaveLength(1)
    expect(calls.memoryContexts[0]?.memory_context).toMatchObject({
      bindings: [
        { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
        { name: "speaker", source: { scope: "speaker", speaker_public_id: "owner-b" }, access: "read_write" },
        { name: "agent", source: { scope: "agent" }, access: "read_write" },
        { name: "workspace", source: { scope: "workspace" }, access: "read_write" },
      ],
      mode: "index",
    })

    conversations.get(first.public_id)!.archived_at = new Date().toISOString()

    const recreated = await channels.ensurePersonalDesk({ client: fixture.client, workspace_public_id: "ws-1" })

    expect(recreated.public_id).not.toBe(first.public_id)
    expect(calls.created).toHaveLength(2)

    conversations.delete(recreated.public_id)

    const restored = await channels.ensurePersonalDesk({ client: fixture.client, workspace_public_id: "ws-1" })

    expect(restored.public_id).not.toBe(recreated.public_id)
    expect(calls.created).toHaveLength(3)
  } finally {
    fixture.server.stop(true)
  }
})

test("quiet hours honor the configured time zone and overnight windows", async () => {
  const { fixture, calls } = channelFixture()
  const now = { at: new Date("2026-11-26T15:30:00Z") }
  const channels = new Channels(fixture.client.profile.storeEntries, () => now.at)

  try {
    await channels.updateAttentionPolicy({
      quiet_hours: { enabled: true, start: "22:00", end: "08:00", time_zone: "Australia/Perth" },
    })

    const suppressed = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Perth is asleep",
      purpose: "result",
      proactive: true,
    })

    expect(suppressed).toEqual({ queued: false, suppressed_reason: "quiet_hours" })

    now.at = new Date("2026-11-26T02:00:00Z")

    const outside = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Perth is awake",
      purpose: "result",
      proactive: true,
    })

    expect(outside.queued).toBe(true)

    await channels.updateAttentionPolicy({
      quiet_hours: { enabled: true, start: "09:00", end: "17:00", time_zone: "UTC" },
    })

    now.at = new Date("2026-11-26T12:00:00Z")

    const midday = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Midday suppression",
      purpose: "acknowledgement",
      proactive: true,
    })

    expect(midday).toEqual({ queued: false, suppressed_reason: "quiet_hours" })

    const attention = await channels.enqueueReply({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Needs attention",
      purpose: "attention",
      proactive: true,
    })

    expect(attention.queued).toBe(true)
    expect(calls.outbox.at(-1)).toMatchObject({ body: "Needs attention", purpose: "attention" })
  } finally {
    fixture.server.stop(true)
  }
})

test("proactive replays do not consume the daily budget", async () => {
  const { fixture } = channelFixture()
  const now = { at: new Date("2026-11-26T10:00:00Z") }
  const channels = new Channels(fixture.client.profile.storeEntries, () => now.at)

  try {
    await channels.updateAttentionPolicy({ daily_proactive_limit: 2 })

    const input = {
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Brief",
      purpose: "result",
      proactive: true,
    } as const

    const first = await channels.enqueueReply({ ...input, idempotency_key: "key-1" })

    expect(first.queued).toBe(true)

    const replayed = await channels.enqueueReply({ ...input, idempotency_key: "key-1" })

    expect(replayed).toMatchObject({ queued: true, replayed: true })

    const second = await channels.enqueueReply({ ...input, idempotency_key: "key-2" })

    expect(second.queued).toBe(true)

    const capped = await channels.enqueueReply({ ...input, idempotency_key: "key-3" })

    expect(capped).toEqual({ queued: false, suppressed_reason: "daily_limit_exceeded" })
  } finally {
    fixture.server.stop(true)
  }
})

test("drain settles failed verdicts, unexpected outcomes and missing adapters", async () => {
  const { fixture, calls, state } = channelFixture()
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    state.claimable = [
      outboxRow({ public_id: "m1", channel_key: "telegram:conn-1", body: "boom" }),
      outboxRow({ public_id: "m2", channel_key: "telegram:conn-1", body: "weird" }),
      outboxRow({ public_id: "m3", channel_key: "slack:conn-1", body: "ok" }),
    ]
    Channels.registerAdapter("telegram", (message) => {
      if (message.body === "boom") return ["failed", "provider timeout"]
      return 42
    })

    const drained = await channels.drainOutbox({
      client: fixture.client,
      workspace_public_id: "ws-1",
      channel_key: "telegram",
      limit: 5,
      lease_seconds: 10,
    })

    expect(calls.claims[0]).toEqual({ channel_key: "telegram", limit: 5, lease_seconds: 10 })
    expect(drained).toEqual([
      { public_id: "m1", outcome: "failed", error: "provider timeout" },
      { public_id: "m2", outcome: "failed" },
      { public_id: "m3", outcome: "no_adapter" },
    ])
    expect(calls.settlements).toEqual([
      ["m1", { action: "failed", error: "provider timeout" }],
      ["m2", { action: "failed", error: "unexpected_adapter_outcome" }],
    ])
  } finally {
    fixture.server.stop(true)
  }
})

test("conflicting store writes retry the mutation until it lands", async () => {
  const counter = { putAttempts: 0, failPuts: 0 }
  const { fixture } = channelFixture((request) => {
    const url = new URL(request.url)

    if (request.method === "PATCH" && url.pathname.includes("/store_entries/")) {
      counter.putAttempts++
      if (counter.failPuts > 0) {
        counter.failPuts--
        return Response.json({ error: { code: "stale_object" } }, { status: 409 })
      }
    }

    return undefined
  })
  const channels = new Channels(fixture.client.profile.storeEntries)

  try {
    await channels.upsertSource({ source_key: "github", name: "GitHub" })

    counter.failPuts = 2
    await channels.upsertSource({ source_key: "telegram", name: "Telegram" })

    expect(counter.putAttempts).toBe(3)

    const overview = await channels.overview()

    expect(overview.sources.map((row) => row.source_key).sort()).toEqual(["github", "telegram"])
  } finally {
    fixture.server.stop(true)
  }
})
