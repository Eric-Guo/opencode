import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { Channels } from "../src/channels"
import { Configuration } from "../src/configuration"
import { ExtensionManager, type ExtensionModule } from "../src/extension-manager"
import type { InboxPartition } from "../src/inbox"
import { packageTools } from "../src/package-tools"
import { Packages } from "../src/packages"
import { checkInPrefix, type RoutinesList } from "../src/routines"
import { superagentTools } from "../src/superagent-tools"
import { storeFixture } from "./fixture/store"
import { conversationFixture, turnFixture } from "./fixture/conversation"

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

function scheduleRow(fields: JsonObject): JsonObject {
  return {
    public_id: "sched-1",
    workspace_public_id: "workspace",
    name: null,
    prompt: "Review",
    rule: { kind: "daily", local_time: "09:00" },
    wake: "auto",
    status: "active",
    lock_version: 1,
    next_run_at: null,
    conversation_public_id: null,
    ...fields,
  }
}

function subscriptionRow(fields: JsonObject): JsonObject {
  return {
    public_id: "sub-1",
    conversation_public_id: "conversation",
    source_key: "github",
    thread_key: "pr-1",
    mode: "active",
    stopped_at: null,
    created_at: new Date().toISOString(),
    ...fields,
  }
}

function runRow(fields: JsonObject): JsonObject {
  return {
    public_id: "run-1",
    workspace_public_id: "workspace",
    status: "running",
    failure_reason: null,
    tasks: [],
    task_progress: {
      total: 0,
      waiting: 0,
      needs_approval: 0,
      running: 0,
      dispatched: 0,
      awaiting_input: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      timed_out: 0,
      uncertain: 0,
      skipped: 0,
    },
    attention: null,
    turn: null,
    ...fields,
  }
}

function collectionRow(fields: JsonObject): JsonObject {
  return {
    public_id: "collection",
    name: null,
    description: null,
    scope: "agent",
    owner_public_id: "main",
    is_default: true,
    lock_version: 0,
    created_at: "now",
    updated_at: "now",
    writable: true,
    manageable: true,
    ...fields,
  }
}

function superagentFixture() {
  const calls = {
    speakers: [] as JsonObject[],
    created: [] as JsonObject[],
    triggers: [] as JsonObject[],
    handbacks: [] as [string, JsonObject][],
    outbox: [] as JsonObject[],
    claims: [] as JsonObject[],
    settlements: [] as [string, JsonObject][],
    subscriptions: [] as JsonObject[],
    deletedSubscriptions: [] as string[],
    scheduleWrites: [] as { method: string; path: string; body: JsonObject }[],
    memoryWrites: [] as JsonObject[],
  }
  const conversations = new Map<string, JsonObject>()
  const subscriptions = new Map<string, JsonObject[]>()
  const schedules: JsonObject[] = []
  const state = {
    fannedOut: [] as string[],
    claimable: [] as JsonObject[],
    outboxRows: [] as JsonObject[],
    profileCollections: [] as JsonObject[],
    workspaceCollections: [] as JsonObject[],
    documents: [] as JsonObject[],
    triggerSequence: 0,
  }

  const fixture = storeFixture(async (request) => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path.includes("/store_entries")) return undefined

    if (path.endsWith("/ingress_speakers") && request.method === "POST") {
      const input = (await request.json()) as { ingress_speaker: JsonObject }

      calls.speakers.push(input.ingress_speaker)
      return Response.json(
        { ingress_speaker: { kind: "ingress", ...input.ingress_speaker, public_id: "owner-1" } },
        { status: 201 },
      )
    }

    if (path.includes("/triggers/") && path.endsWith("/handback") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const input = (await request.json()) as { handback: JsonObject }

      calls.handbacks.push([id, input.handback])
      return Response.json({ queued: true, disposition: { handed_back: {} } })
    }

    if (path.endsWith("/triggers") && request.method === "POST") {
      const input = (await request.json()) as { trigger: JsonObject }

      calls.triggers.push(input.trigger)
      state.triggerSequence++
      return Response.json({
        outcome: "stored",
        trigger: {
          public_id: "trig-" + state.triggerSequence,
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
      return Response.json({ conversation: conversations.get(id) }, { status: 201 })
    }

    if (path.endsWith("/conversations/archived") && request.method === "GET")
      return Response.json({
        conversations: [...conversations.values()].filter((row) => row.archived_at !== null),
        pagination: { next_after: null },
      })

    if (path.endsWith("/conversations") && request.method === "GET")
      return Response.json({
        conversations: [...conversations.values()].filter((row) => row.archived_at === null),
        pagination: { next_after: null },
      })

    if (path.endsWith("/thread_subscriptions") && request.method === "GET") {
      const id = path.split("/").at(-2)!

      return Response.json({ thread_subscriptions: subscriptions.get(id) ?? [] })
    }
    if (path.endsWith("/thread_subscriptions") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const input = (await request.json()) as { thread_subscription: JsonObject }
      const row = subscriptionRow({
        ...input.thread_subscription,
        conversation_public_id: id,
        public_id: "sub-" + ((subscriptions.get(id)?.length ?? 0) + 1),
      })

      subscriptions.set(id, [...(subscriptions.get(id) ?? []), row])
      calls.subscriptions.push(input.thread_subscription)
      return Response.json({ thread_subscription: row }, { status: 201 })
    }
    if (path.includes("/thread_subscriptions/") && request.method === "DELETE") {
      const parts = path.split("/")
      const id = parts.at(-3)!
      const subscription = parts.at(-1)!

      subscriptions.set(id, (subscriptions.get(id) ?? []).filter((row) => row.public_id !== subscription))
      calls.deletedSubscriptions.push(subscription)
      return new Response(null, { status: 204 })
    }

    if (path.includes("/schedules/") && request.method !== "GET") {
      const body = request.method === "PATCH" ? ((await request.json()) as { schedule: JsonObject }).schedule : {}

      calls.scheduleWrites.push({ method: request.method, path, body })
      const parts = path.split("/")
      const verb = ["pause", "resume", "cancel"].includes(parts.at(-1)!) ? parts.at(-1)! : null
      const id = verb ? parts.at(-2)! : parts.at(-1)!

      return Response.json({
        schedule: scheduleRow({
          public_id: id,
          conversation_public_id: parts.at(-3)!,
          status: verb === "pause" ? "paused" : verb === "cancel" ? "canceled" : "active",
        }),
      })
    }
    if (path.endsWith("/schedules") && request.method === "GET")
      return Response.json({ schedules, pagination: { next_after: null } })

    if (path.endsWith("/memory_context") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const row = conversations.get(id)!
      const input = (await request.json()) as { memory_context: JsonObject }

      row.memory_context = input.memory_context
      return Response.json({ conversation: row })
    }

    if (path.endsWith("/archive") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const row = conversations.get(id)

      if (!row) return Response.json({ error: { code: "not_found" } }, { status: 404 })

      const archived = { ...row, archived_at: new Date().toISOString() }

      conversations.set(id, archived)
      return Response.json({ conversation: archived })
    }

    if (path.includes("/turns/") && request.method === "GET") {
      const id = path.split("/").at(-1)!
      const variant = {
        public_id: "variant-1",
        source: "original",
        status: "running",
        active: true,
        run_public_id: "run-1",
      }

      return Response.json({
        turn: turnFixture(1, { public_id: id, status: "running", active_variant: variant, running_variant: variant }),
      })
    }

    if (path.includes("/runs/") && request.method === "GET") {
      const id = path.split("/").at(-1)!

      return Response.json({ run: runRow({ public_id: id }) })
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
      const row = outboxRow({ public_id: "out-" + (state.outboxRows.length + 1), ...input.outbox_message })

      state.outboxRows.push(row)
      calls.outbox.push(input.outbox_message)
      return Response.json({ outbox_message: row }, { status: 201 })
    }

    if (path.endsWith("/outbox_messages") && request.method === "GET")
      return Response.json({ outbox_messages: state.outboxRows })

    if (path.endsWith("/memory_collections") && request.method === "GET")
      return Response.json({
        memory_collections: path.includes("/profile/")
          ? state.profileCollections
          : path.includes("/workspaces/workspace/")
            ? state.workspaceCollections
            : [],
        pagination: { next_after: null },
      })

    if (path.endsWith("/documents") && request.method === "GET") return Response.json({ memory: state.documents })
    if (path.endsWith("/documents") && request.method === "POST") {
      const input = (await request.json()) as { memory: JsonObject }
      const row = {
        collection_public_id: path.split("/").at(-2)!,
        public_id: "doc-" + (state.documents.length + 1),
        lock_version: 0,
        bytesize: String(input.memory.content).length,
        written_at: new Date().toISOString(),
        ...input.memory,
      }

      state.documents.push(row)
      calls.memoryWrites.push(input.memory)
      return Response.json({ memory: row }, { status: 201 })
    }

    if (path.includes("/conversations/") && request.method === "GET") {
      const id = path.split("/").at(-1)!
      const row = conversations.get(id)

      return row
        ? Response.json({ conversation: row })
        : Response.json({ error: { code: "not_found" } }, { status: 404 })
    }

    return Response.json({ error: { code: "unexpected_request" } }, { status: 400 })
  })

  return { fixture, calls, conversations, subscriptions, schedules, state }
}

function application(fixture: ReturnType<typeof storeFixture>, base: () => Record<string, unknown> = () => ({})) {
  return new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    base as never,
  )
}

afterEach(() => {
  for (const prefix of Channels.registeredPrefixes()) Channels.unregisterAdapter(prefix)
})

test("personal_desk ensures the workspace desk with the resolved owner speaker", async () => {
  const { fixture, calls } = superagentFixture()
  const app = application(fixture)

  try {
    const first = (await app.operations.command({ action: "personal_desk" })) as { conversation: JsonObject }

    expect(first.conversation.title).toBe("Personal Desk")
    expect(calls.speakers).toEqual([{ channel_key: "rho:main", external_id: "owner", display_name: "Owner" }])
    expect(calls.created[0]).toMatchObject({
      title: "Personal Desk",
      metadata: { "opencode.surface": "personal_desk", rho_bot_public_id: "personal" },
      memory_context: {
        bindings: [
          { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
          { name: "speaker", source: { scope: "speaker", speaker_public_id: "owner-1" }, access: "read_write" },
          { name: "agent", source: { scope: "agent" }, access: "read_write" },
          { name: "workspace", source: { scope: "workspace" }, access: "read_write" },
        ],
        mode: "index",
      },
    })

    const again = (await app.operations.command({ action: "personal_desk" })) as { conversation: JsonObject }

    expect(again.conversation.public_id).toBe(first.conversation.public_id)
    expect(calls.created).toHaveLength(1)

    await app.operations.command({ action: "personal_desk", workspace: "other" })
    expect(calls.created).toHaveLength(2)
    expect(calls.created[1]?.title).toBe("Personal Desk")

    await app.operations.command({ action: "personal_desk", workspace: "attached", attach_runner: true })
    expect(calls.created[2]?.default_runner_executor_public_id).toBe("runner")

    await app.operations.command({
      action: "personal_desk",
      workspace: "explicit",
      attach_runner: true,
      default_runner_executor_public_id: "runner-2",
    })
    expect(calls.created[3]?.default_runner_executor_public_id).toBe("runner-2")

    await app.operations.command({
      action: "personal_desk",
      workspace: "detached",
      attach_runner: true,
      default_runner_executor_public_id: "",
    })
    expect(calls.created[4]?.default_runner_executor_public_id).toBeNull()

    await app.operations.command({ action: "personal_desk", workspace: "plain", default_runner_executor_public_id: "runner-3" })
    expect(calls.created[5]?.default_runner_executor_public_id).toBeNull()
  } finally {
    fixture.server.stop(true)
  }
})

test("inbox partitions followed runs, automation and snoozed conversations", async () => {
  const { fixture, calls, conversations, schedules } = superagentFixture()
  const app = application(fixture)

  try {
    const desk = (await app.operations.command({ action: "personal_desk" })) as { conversation: JsonObject }
    const deskId = String(desk.conversation.public_id)

    conversations.set(
      deskId,
      conversationFixture({
        ...desk.conversation,
        public_id: deskId,
        last_activity_at: "2026-11-26T12:00:00Z",
        created_at: "2026-11-26T11:00:00Z",
      }),
    )
    conversations.set(
      "conv-running",
      conversationFixture({
        public_id: "conv-running",
        title: "Running task",
        active_turn_public_id: "turn-1",
        last_activity_at: "2026-11-26T12:00:00Z",
        created_at: "2026-11-26T11:00:00Z",
      }),
    )
    conversations.set(
      "conv-auto",
      conversationFixture({
        public_id: "conv-auto",
        title: "Standing monitor",
        last_activity_at: "2026-11-26T12:30:00Z",
        created_at: "2026-11-26T11:00:00Z",
      }),
    )
    conversations.set(
      "conv-idle",
      conversationFixture({
        public_id: "conv-idle",
        title: "Idle task",
        last_activity_at: "2026-11-26T12:10:00Z",
        created_at: "2026-11-26T11:00:00Z",
      }),
    )
    conversations.set(
      "conv-done",
      conversationFixture({
        public_id: "conv-done",
        title: "Old task",
        archived_at: "2026-11-26T13:00:00Z",
        last_activity_at: "2026-11-26T12:00:00Z",
        created_at: "2026-11-26T11:00:00Z",
      }),
    )
    schedules.push(scheduleRow({ public_id: "sched-1", conversation_public_id: "conv-auto" }))
    app.lifecycle.adopt("workspace", "conv-running")
    await app.operations.command({
      action: "skills.drafts.propose",
      name: "weekly-digest",
      scope: "agent",
      description: "Weekly",
      content: "# Digest\n",
    })

    const first = (await app.operations.command({ action: "inbox" })) as { inbox: InboxPartition }

    expect(first.inbox.personal_desk).toMatchObject({ public_id: deskId, is_personal_desk: true })
    expect(first.inbox.sections.running.map((row) => row.public_id)).toEqual(["conv-running"])
    expect(first.inbox.sections.running[0]).toMatchObject({ run_status: "running", reason: "working" })
    expect(first.inbox.sections.needs_you.map((row) => row.public_id).sort()).toEqual(
      [deskId, "conv-auto", "conv-idle"].sort(),
    )
    expect(first.inbox.sections.needs_you.find((row) => row.public_id === "conv-auto")).toMatchObject({
      has_automation: true,
      reason: "automation_enabled",
    })
    expect(first.inbox.sections.needs_you.find((row) => row.public_id === "conv-idle")).toMatchObject({
      reason: "ready",
    })
    expect(first.inbox.sections.done.map((row) => row.public_id)).toEqual(["conv-done"])
    expect(first.inbox.counts).toEqual({ needs_you: 3, running: 1, snoozed: 0, done: 1, skill_drafts: 1 })

    const until = new Date(Date.now() + 3_600_000).toISOString()
    const snoozed = (await app.operations.command({
      action: "inbox.snooze",
      conversation: "conv-idle",
      until_at: until,
    })) as { inbox_entry: JsonObject }

    expect(snoozed.inbox_entry.snoozed_until).toBe(until.replace(/\.\d{3}Z$/, "Z"))
    expect(snoozed.inbox_entry.snoozed_at).toBeString()

    const afterSnooze = (await app.operations.command({ action: "inbox" })) as { inbox: InboxPartition }

    expect(afterSnooze.inbox.sections.snoozed.map((row) => row.public_id)).toEqual(["conv-idle"])
    expect(afterSnooze.inbox.counts.snoozed).toBe(1)

    const cleared = (await app.operations.command({
      action: "inbox.snooze",
      conversation: "conv-idle",
      until_at: null,
    })) as { inbox_entry: JsonObject }

    expect(cleared.inbox_entry).toEqual({})

    const read = (await app.operations.command({
      action: "inbox.read",
      conversation: "conv-auto",
      activity_at: "2026-11-26T12:30:00Z",
    })) as { inbox_entry: JsonObject }

    expect(read.inbox_entry.read_at).toBe("2026-11-26T12:30:00Z")

    const afterRead = (await app.operations.command({ action: "inbox" })) as { inbox: InboxPartition }

    expect(afterRead.inbox.sections.running.map((row) => row.public_id).sort()).toEqual(["conv-auto", "conv-running"])

    const done = (await app.operations.command({ action: "inbox.done", conversation: "conv-idle" })) as JsonObject

    expect(done).toEqual({ outcome: "archived", conversation_public_id: "conv-idle" })
    expect(conversations.get("conv-idle")?.archived_at).not.toBeNull()

    const deskDone = (await app.operations.command({ action: "inbox.done", conversation: deskId })) as JsonObject

    expect(deskDone).toMatchObject({ outcome: "marked_read", conversation_public_id: deskId })
    expect(conversations.get(deskId)?.archived_at).toBeNull()
    expect(calls.scheduleWrites).toEqual([])
  } finally {
    fixture.server.stop(true)
  }
})

test("channels operations cover overview, sources, attention, ingest and outbox", async () => {
  const { fixture, calls, state } = superagentFixture()
  const app = application(fixture, () => ({ default_model: "provider/default" }))

  try {
    const source = (await app.operations.command({
      action: "channels.source",
      source_key: "github",
      name: "GitHub",
      accept_mode: "observe",
      allowed_senders: ["alice"],
    })) as { source: JsonObject }

    expect(source.source).toMatchObject({
      source_key: "github",
      name: "GitHub",
      kind: "webhook",
      enabled: true,
      target: "personal",
      accept_mode: "observe",
      allowed_senders: ["alice"],
    })
    await expect(
      app.operations.command({ action: "channels.source", source_key: "Bad!", name: "x" }),
    ).rejects.toThrow("source_key must match [a-z0-9][a-z0-9:._-]{0,63}")

    const attention = (await app.operations.command({
      action: "channels.attention",
      quiet_hours: { enabled: true, start: "21:00", end: "07:00" },
      daily_proactive_limit: 3,
    })) as { attention_policy: JsonObject }

    expect(attention.attention_policy).toEqual({
      quiet_hours: { enabled: true, start: "21:00", end: "07:00", time_zone: "UTC" },
      daily_proactive_limit: 3,
    })
    await expect(
      app.operations.command({ action: "channels.attention", daily_proactive_limit: 0 }),
    ).rejects.toThrow("daily_proactive_limit must be between 1 and 100")

    await app.operations.command({
      action: "routines.create",
      kind: "event",
      name: "CI Failure Triage",
      source_key: "github",
      pattern: "ci failed",
      instructions: "Inspect failing workflow logs.",
      does: "check_in",
    })

    const observed = (await app.operations.command({
      action: "channels.ingest",
      source_key: "github",
      external_id: "evt-1",
      thread_key: "pr-12",
      text: "CI failed on main build",
      actor_id: "actions-bot",
      actor_kind: "bot",
    })) as JsonObject

    expect(observed.outcome).toBe("observed")
    expect(calls.created).toHaveLength(0)
    expect(calls.triggers.at(-1)).toMatchObject({ addressed: false, actor_kind: "bot" })

    await app.operations.command({
      action: "channels.source",
      source_key: "github",
      name: "GitHub",
      accept_mode: "auto",
      allowed_senders: ["alice"],
    })

    const accepted = (await app.operations.command({
      action: "channels.ingest",
      source_key: "github",
      external_id: "evt-2",
      thread_key: "pr-99",
      text: "CI failed on release branch",
      actor_id: "actions-bot",
      actor_kind: "bot",
    })) as JsonObject

    expect(accepted.outcome).toBe("stored")
    expect(accepted.routed_conversation_public_id).toBeString()
    expect(calls.created).toHaveLength(1)
    expect(calls.triggers.at(-1)?.model).toBe("provider/default")
    expect(calls.triggers.at(-1)?.router_conversation_public_id).toBeString()

    await app.operations.command({
      action: "channels.ingest",
      source_key: "github",
      external_id: "evt-3",
      thread_key: "pr-100",
      text: "CI failed again",
      actor_id: "actions-bot",
      actor_kind: "bot",
      model: "provider/override",
    })
    expect(calls.triggers.at(-1)?.model).toBe("provider/override")

    const enqueued = (await app.operations.command({
      action: "channels.outbox.enqueue",
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Direct answer",
      purpose: "answer",
      conversation: "conv-1",
    })) as JsonObject

    expect(enqueued).toMatchObject({ queued: true, replayed: false })
    expect(calls.outbox.at(-1)).toMatchObject({
      channel_key: "telegram:conn-1",
      thread_key: "1001",
      body: "Direct answer",
      purpose: "answer",
      conversation_public_id: "conv-1",
    })
    await expect(
      app.operations.command({ action: "channels.outbox.enqueue", channel_key: "k", thread_key: "t", body: " " }),
    ).rejects.toThrow("reply body is required")

    state.claimable = [outboxRow({ public_id: "m1", body: "ok" })]
    Channels.registerAdapter("telegram", () => "sent")

    const drained = (await app.operations.command({ action: "channels.outbox.drain" })) as JsonObject

    expect(drained).toEqual({ settlements: [{ public_id: "m1", outcome: "sent" }] })
    expect(calls.claims[0]).toEqual({ limit: 20, lease_seconds: 30 })
    expect(calls.settlements).toEqual([["m1", { action: "sent" }]])

    const overview = (await app.operations.command({ action: "channels" })) as { channels: JsonObject }

    expect(overview.channels.sources).toHaveLength(1)
    expect(overview.channels.event_rules).toHaveLength(1)
    expect(overview.channels.observations).toHaveLength(1)
    expect(overview.channels.outbox_messages).toHaveLength(1)
    expect(overview.channels.desks).toMatchObject({ workspace: expect.any(String) })

    const removed = (await app.operations.command({
      action: "channels.source.rm",
      source_key: "github",
    })) as { removed: JsonObject }

    expect(removed.removed.source_key).toBe("github")
    await expect(app.operations.command({ action: "channels.source.rm", source_key: "github" })).rejects.toThrow(
      "No channel source github",
    )
  } finally {
    fixture.server.stop(true)
  }
})

test("subscriptions and handback mirror the thread coordination routes", async () => {
  const { fixture, calls, conversations, subscriptions } = superagentFixture()
  const app = application(fixture, () => ({ default_model: "provider/default" }))

  try {
    const created = (await app.operations.command({
      action: "subscriptions.create",
      conversation: "conv-ticket",
      source_key: "github",
      thread_key: "pr-1",
    })) as { thread_subscription: JsonObject }

    expect(created.thread_subscription).toMatchObject({
      public_id: "sub-1",
      conversation_public_id: "conv-ticket",
      source_key: "github",
      thread_key: "pr-1",
      mode: "active",
    })
    expect(calls.subscriptions[0]).toEqual({ source_key: "github", thread_key: "pr-1", mode: "active" })

    const listed = (await app.operations.command({
      action: "subscriptions",
      conversation: "conv-ticket",
    })) as { thread_subscriptions: JsonObject[] }

    expect(listed.thread_subscriptions).toHaveLength(1)

    const removed = (await app.operations.command({
      action: "subscriptions.rm",
      conversation: "conv-ticket",
      source_key: "github",
      thread_key: "pr-1",
    })) as { deleted: JsonObject }

    expect(removed).toEqual({ deleted: { public_id: "sub-1" } })
    expect(calls.deletedSubscriptions).toEqual(["sub-1"])
    expect(subscriptions.get("conv-ticket")).toEqual([])

    await expect(
      app.operations.command({ action: "subscriptions.rm", conversation: "conv-ticket", source_key: "github", thread_key: "pr-1" }),
    ).rejects.toThrow("No matching thread subscription")

    await app.operations.command({
      action: "subscriptions.create",
      conversation: "conv-ticket",
      source_key: "github",
      thread_key: "pr-2",
      mode: "context_only",
    })
    const byId = (await app.operations.command({
      action: "subscriptions.rm",
      conversation: "conv-ticket",
      subscription: "sub-2",
    })) as { deleted: JsonObject }

    expect(byId).toEqual({ deleted: { public_id: "sub-2" } })

    await expect(
      app.operations.command({ action: "triggers.handback", reason: "Out of scope" }),
    ).rejects.toThrow("trigger_public_id (or external_id/source_key+thread_key) and reason are required")

    await app.operations.command({
      action: "channels.source",
      source_key: "github",
      name: "GitHub",
      accept_mode: "auto",
    })
    await app.operations.command({
      action: "channels.ingest",
      source_key: "github",
      external_id: "evt-9",
      thread_key: "pr-9",
      text: "@rho please look",
      actor_id: "alice",
      addressed: true,
    })

    await expect(
      app.operations.command({
        action: "triggers.handback",
        external_id: "evt-9",
        reason: "Out of scope for this ticket",
      }),
    ).rejects.toThrow(
      "conversation_public_id, trigger_public_id (or external_id/source_key+thread_key) and reason are required",
    )

    const handed = (await app.operations.command({
      action: "triggers.handback",
      external_id: "evt-9",
      conversation: "conv-ticket",
      reason: "Out of scope for this ticket",
    })) as { handback: JsonObject }
    const deskId = [...conversations.keys()].at(-1)!

    expect(handed.handback).toMatchObject({ queued: true })
    expect(calls.handbacks.at(-1)).toEqual([
      "trig-1",
      {
        conversation_public_id: "conv-ticket",
        reason: "Out of scope for this ticket",
        router_conversation_public_id: deskId,
        model: "provider/default",
      },
    ])

    await app.operations.command({
      action: "triggers.handback",
      trigger: "550e8400-e29b-41d4-a716-446655440000",
      conversation: "conv-ticket",
      reason: "Not mine",
      router: "conv-router",
      model: "provider/override",
    })
    expect(calls.handbacks.at(-1)).toEqual([
      "550e8400-e29b-41d4-a716-446655440000",
      {
        conversation_public_id: "conv-ticket",
        reason: "Not mine",
        router_conversation_public_id: "conv-router",
        model: "provider/override",
      },
    ])

    await expect(
      app.operations.command({
        action: "triggers.handback",
        trigger: "550e8400-e29b-41d4-a716-446655440000",
        reason: "   ",
      }),
    ).rejects.toThrow("trigger_public_id (or external_id/source_key+thread_key) and reason are required")
  } finally {
    fixture.server.stop(true)
  }
})

test("routines list and mutate event and time kinds", async () => {
  const { fixture, calls, schedules } = superagentFixture()
  const app = application(fixture)

  try {
    const empty = (await app.operations.command({ action: "routines" })) as RoutinesList

    expect(empty.routines).toEqual([])
    expect(empty.time_routines).toEqual([])
    expect(empty.event_routines).toEqual([])

    const created = (await app.operations.command({
      action: "routines.create",
      kind: "event",
      name: "PR Watch",
      source_key: "github",
      what: "Inspect PR diff.",
      pattern: "review_requested",
      does: "check_in",
    })) as { routine: JsonObject }

    expect(created.routine).toMatchObject({
      kind: "event",
      name: "PR Watch",
      source_key: "github",
      instructions: "Inspect PR diff.",
      pattern: "review_requested",
      does: "check_in",
      enabled: true,
    })
    const ruleId = String(created.routine.public_id)

    const updated = (await app.operations.command({
      action: "routines.update",
      kind: "event",
      public_id: ruleId,
      what: "Inspect the full PR diff.",
    })) as { routine: JsonObject }

    expect(updated.routine).toMatchObject({
      kind: "event",
      instructions: "Inspect the full PR diff.",
      pattern: "review_requested",
      does: "check_in",
    })

    const toggled = (await app.operations.command({
      action: "routines.toggle",
      kind: "event",
      public_id: ruleId,
      enabled: false,
    })) as { routine: JsonObject }

    expect(toggled.routine).toMatchObject({ kind: "event", enabled: false })

    schedules.push(
      scheduleRow({
        public_id: "sched-1",
        conversation_public_id: "conv-1",
        name: "Morning Check",
        prompt: checkInPrefix + "Check inbox",
        wake: "passive",
      }),
    )

    const unified = (await app.operations.command({ action: "routines" })) as RoutinesList

    expect(unified.routines).toHaveLength(2)
    expect(unified.time_routines[0]).toMatchObject({
      kind: "time",
      public_id: "sched-1",
      name: "Morning Check",
      what: "Check inbox",
      does: "check_in",
      wake: "passive",
    })
    expect(unified.event_routines[0]).toMatchObject({ kind: "event", name: "PR Watch", status: "paused" })

    const timeUpdated = (await app.operations.command({
      action: "routines.update",
      kind: "time",
      public_id: "sched-1",
      conversation: "conv-1",
      expected_lock_version: 1,
      name: "Morning",
      what: "Check the inbox",
      does: "check_in",
      rule: { kind: "daily", local_time: "08:30", time_zone: "UTC" },
    })) as { routine: JsonObject }

    expect(timeUpdated.routine).toMatchObject({ kind: "time", public_id: "sched-1" })
    expect(calls.scheduleWrites.at(-1)).toEqual({
      method: "PATCH",
      path: "/agent_api/v1/workspaces/workspace/conversations/conv-1/schedules/sched-1",
      body: {
        expected_lock_version: 1,
        name: "Morning",
        prompt: checkInPrefix + "Check the inbox",
        rule: { kind: "daily", local_time: "08:30", time_zone: "UTC" },
        wake: "passive",
      },
    })

    await app.operations.command({
      action: "routines.update",
      kind: "time",
      public_id: "sched-1",
      conversation: "conv-1",
      expected_lock_version: 2,
      prompt: "Plain update",
    })
    expect(calls.scheduleWrites.at(-1)?.body).toEqual({ expected_lock_version: 2, prompt: "Plain update" })

    await expect(
      app.operations.command({ action: "routines.update", kind: "time", public_id: "sched-1" }),
    ).rejects.toThrow("Missing conversation_public_id")

    const paused = (await app.operations.command({
      action: "routines.toggle",
      kind: "time",
      public_id: "sched-1",
      conversation: "conv-1",
      enabled: false,
    })) as { routine: JsonObject }

    expect(paused.routine).toMatchObject({ kind: "time", status: "paused" })
    expect(calls.scheduleWrites.at(-1)?.path).toBe(
      "/agent_api/v1/workspaces/workspace/conversations/conv-1/schedules/sched-1/pause",
    )

    await app.operations.command({
      action: "routines.toggle",
      kind: "time",
      public_id: "sched-1",
      conversation: "conv-1",
      enabled: true,
    })
    expect(calls.scheduleWrites.at(-1)?.path).toBe(
      "/agent_api/v1/workspaces/workspace/conversations/conv-1/schedules/sched-1/resume",
    )

    const canceled = (await app.operations.command({
      action: "routines.rm",
      kind: "time",
      public_id: "sched-1",
      conversation: "conv-1",
    })) as { routine: JsonObject }

    expect(canceled.routine).toMatchObject({ kind: "time", status: "canceled" })
    expect(calls.scheduleWrites.at(-1)?.path).toBe(
      "/agent_api/v1/workspaces/workspace/conversations/conv-1/schedules/sched-1/cancel",
    )

    const removed = (await app.operations.command({
      action: "routines.rm",
      kind: "event",
      public_id: ruleId,
    })) as { removed: JsonObject }

    expect(removed.removed.public_id).toBe(ruleId)
    await expect(
      app.operations.command({ action: "routines.rm", kind: "event", public_id: ruleId }),
    ).rejects.toThrow("No event routine with public id " + ruleId)
    await expect(app.operations.command({ action: "routines.create", kind: "time" })).rejects.toThrow()
  } finally {
    fixture.server.stop(true)
  }
})

test("skills drafts propose, approve into the default collection and dismiss", async () => {
  const { fixture, calls, state } = superagentFixture()
  const app = application(fixture)

  try {
    state.profileCollections.push(collectionRow({ public_id: "collection", scope: "agent", owner_public_id: "main" }))

    const proposed = (await app.operations.command({
      action: "skills.drafts.propose",
      name: "weekly-digest",
      scope: "agent",
      description: "Summarize the week.",
      content: "# Weekly Digest\n",
      conversation: "conv-1",
    })) as { skill_draft: JsonObject }

    expect(proposed.skill_draft).toMatchObject({
      name: "weekly-digest",
      scope: "agent",
      description: "Summarize the week.",
      content: "# Weekly Digest\n",
      conversation_public_id: "conv-1",
      workspace_public_id: "workspace",
    })
    const draftId = String(proposed.skill_draft.public_id)

    const listed = (await app.operations.command({ action: "skills.drafts" })) as { skill_drafts: JsonObject[] }

    expect(listed.skill_drafts).toHaveLength(1)

    await expect(
      app.operations.command({
        action: "skills.drafts.propose",
        name: "bad",
        scope: "global",
        description: "x",
        content: "y",
      }),
    ).rejects.toThrow("scope must be agent or workspace")

    const approved = (await app.operations.command({
      action: "skills.drafts.approve",
      public_id: draftId,
    })) as JsonObject

    expect(calls.memoryWrites[0]).toEqual({
      path: "skills/weekly-digest",
      content: "# Weekly Digest\n",
      description: "Summarize the week.",
      expected_public_id: null,
      expected_lock_version: null,
    })
    expect(approved.approved_draft_public_id).toBe(draftId)
    expect(approved.memory).toMatchObject({ path: "skills/weekly-digest", public_id: "doc-1" })
    expect(((await app.operations.command({ action: "skills.drafts" })) as { skill_drafts: JsonObject[] }).skill_drafts).toEqual([])

    await expect(app.operations.command({ action: "skills.drafts.approve", public_id: draftId })).rejects.toThrow(
      "No skill draft with public id " + draftId,
    )

    state.workspaceCollections.push(
      collectionRow({ public_id: "ws-collection", scope: "workspace", owner_public_id: "workspace" }),
    )
    state.documents.push({
      collection_public_id: "ws-collection",
      public_id: "doc-existing",
      lock_version: 3,
      path: "skills/pr-triage",
      bytesize: 3,
      content: "old",
      description: "Old",
      written_at: "now",
    })

    const workspaceDraft = (await app.operations.command({
      action: "skills.drafts.propose",
      name: "pr-triage",
      scope: "workspace",
      description: "Triage PRs.",
      content: "# Triage v2\n",
    })) as { skill_draft: JsonObject }

    const reapproved = (await app.operations.command({
      action: "skills.drafts.approve",
      public_id: String(workspaceDraft.skill_draft.public_id),
      workspace: "workspace",
    })) as JsonObject

    expect(calls.memoryWrites.at(-1)).toEqual({
      path: "skills/pr-triage",
      content: "# Triage v2\n",
      description: "Triage PRs.",
      expected_public_id: "doc-existing",
      expected_lock_version: 3,
    })
    expect(reapproved.approved_draft_public_id).toBe(String(workspaceDraft.skill_draft.public_id))

    const orphan = (await app.operations.command({
      action: "skills.drafts.propose",
      name: "orphan",
      scope: "workspace",
      description: "No collection.",
      content: "# Orphan\n",
      workspace: "elsewhere",
    })) as { skill_draft: JsonObject }

    await expect(
      app.operations.command({ action: "skills.drafts.approve", public_id: String(orphan.skill_draft.public_id) }),
    ).rejects.toThrow("memory_scope_unavailable: The target workspace memory collection is unavailable")

    const dismissed = (await app.operations.command({
      action: "skills.drafts.dismiss",
      public_id: String(orphan.skill_draft.public_id),
    })) as { dismissed: JsonObject }

    expect(dismissed.dismissed).toEqual({
      public_id: String(orphan.skill_draft.public_id),
      name: "orphan",
      scope: "workspace",
    })
    await expect(
      app.operations.command({ action: "skills.drafts.dismiss", public_id: "missing" }),
    ).rejects.toThrow("No skill draft with public id missing")
  } finally {
    fixture.server.stop(true)
  }
})

test("channel_dispatch and propose_skill serve the agent through the operations layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-superagent-"))
  const { fixture, calls, conversations } = superagentFixture()
  const app = application(fixture)
  const announced: string[][] = []
  const probe: ExtensionModule = {
    descriptor: {
      id: "probe",
      name: "Probe",
      description: "Captures the announced agent tools.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: { type: "object", properties: {}, additionalProperties: false },
      defaults: {},
    },
    register(api) {
      announced.push(api.announced!("agent").map((tool) => tool.name))
    },
  }
  const manager = new ExtensionManager(
    new Configuration(join(directory, "config.json")),
    [
      superagentTools(),
      packageTools(new Packages(directory, new Configuration(join(directory, "packages.json"))), () => manager),
      probe,
    ],
    directory,
    new AbortController().signal,
    async () => {},
    () => app,
  )
  const context = {
    workspace: "workspace",
    conversation: "conversation",
    run: "run",
    task: "task",
    directory,
    signal: new AbortController().signal,
  }

  try {
    await manager.start()
    expect(announced).toEqual([["channel_dispatch", "propose_skill", "list_extensions", "manage_extension"]])

    const tools = manager.tools()
    const dispatch = tools.find((tool) => tool.definition.name === "channel_dispatch")!
    const propose = tools.find((tool) => tool.definition.name === "propose_skill")!

    expect(dispatch.role).toBe("agent")
    expect(propose.role).toBe("agent")
    expect(dispatch.environmentRequired).toBe(false)
    expect(propose.environmentRequired).toBe(false)
    expect(dispatch.definition.timeout_ms).toBeUndefined()
    expect(propose.definition.timeout_ms).toBeUndefined()
    expect(dispatch.definition.effect_profile).toEqual({
      kind: "write",
      destructive: false,
      effect_scope: "open",
      idempotency: "intrinsic",
      reconciliation: "none",
    })
    expect(propose.definition.effect_profile).toEqual({
      kind: "write",
      destructive: false,
      effect_scope: "closed",
      idempotency: "intrinsic",
      reconciliation: "none",
    })

    const reply = await dispatch.execute(
      { action: "reply", channel_key: "telegram:conn-1", thread_key: "t1", body: "Done", purpose: "answer" },
      context,
    )

    expect(reply.is_error).toBeUndefined()
    expect(JSON.parse(String(reply.content))).toMatchObject({ queued: true, outbox_message: { body: "Done" } })
    expect(calls.outbox.at(-1)).toMatchObject({
      channel_key: "telegram:conn-1",
      thread_key: "t1",
      body: "Done",
      purpose: "answer",
      conversation_public_id: "conversation",
    })

    const refused = await dispatch.execute(
      { action: "reply", channel_key: "telegram:conn-1", thread_key: "t1", body: " " },
      context,
    )

    expect(refused).toMatchObject({ is_error: true, content: "reply body is required" })

    const unknown = await dispatch.execute({ action: "explode" }, context)

    expect(unknown).toMatchObject({ is_error: true, content: "unknown channel_dispatch action: explode" })

    const subscribed = await dispatch.execute({ action: "subscribe", source_key: "github", thread_key: "pr-1" }, context)

    expect(subscribed.is_error).toBeUndefined()
    expect(calls.subscriptions.at(-1)).toEqual({ source_key: "github", thread_key: "pr-1", mode: "active" })

    const unsubscribed = await dispatch.execute(
      { action: "unsubscribe", source_key: "github", thread_key: "pr-1" },
      context,
    )

    expect(unsubscribed.is_error).toBeUndefined()
    expect(calls.deletedSubscriptions).toEqual(["sub-1"])

    const handed = await dispatch.execute(
      {
        action: "handback",
        trigger_public_id: "550e8400-e29b-41d4-a716-446655440000",
        reason: "Out of scope",
      },
      context,
    )

    expect(handed.is_error).toBeUndefined()
    expect(calls.handbacks.at(-1)).toEqual([
      "550e8400-e29b-41d4-a716-446655440000",
      {
        conversation_public_id: "conversation",
        reason: "Out of scope",
        router_conversation_public_id: [...conversations.keys()].at(-1)!,
      },
    ])

    const proposed = await propose.execute(
      { name: "weekly-digest", scope: "agent", description: "Weekly", content: "# Digest\n" },
      context,
    )

    expect(proposed.is_error).toBeUndefined()
    expect(JSON.parse(String(proposed.content))).toMatchObject({
      name: "weekly-digest",
      scope: "agent",
      conversation_public_id: "conversation",
      workspace_public_id: "workspace",
    })

    const invalid = await propose.execute(
      { name: "bad", scope: "global", description: "x", content: "y" },
      context,
    )

    expect(invalid).toMatchObject({ is_error: true, content: "scope must be agent or workspace" })
  } finally {
    await manager.close()
    fixture.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})
