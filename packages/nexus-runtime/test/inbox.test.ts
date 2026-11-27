import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { Inbox, indefinite } from "../src/inbox"
import { SkillDrafts } from "../src/skill-drafts"
import { storeFixture } from "./fixture/store"
import { conversationFixture } from "./fixture/conversation"

function summaryRow(fields: JsonObject): JsonObject {
  return conversationFixture({
    public_id: "conv-x",
    workspace_public_id: "ws-1",
    last_activity_at: "2026-11-26T12:00:00Z",
    created_at: "2026-11-26T11:00:00Z",
    ...fields,
  })
}

function scheduleRow(fields: JsonObject): JsonObject {
  return {
    public_id: "sched-x",
    workspace_public_id: "ws-1",
    name: null,
    prompt: "Standup",
    rule: { kind: "daily", local_time: "09:00" },
    wake: "auto",
    status: "active",
    lock_version: 0,
    conversation_public_id: null,
    ...fields,
  }
}

function inboxFixture() {
  const conversations = new Map<string, JsonObject>()
  const schedules: JsonObject[] = []
  const subscriptions = new Map<string, JsonObject[]>()
  const archivedIds: string[] = []
  let now = new Date("2026-11-26T14:00:00Z")

  const fixture = storeFixture(async (request) => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path.includes("/store_entries")) return undefined

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
    if (path.endsWith("/schedules") && request.method === "GET")
      return Response.json({ schedules, pagination: { next_after: null } })
    if (path.endsWith("/thread_subscriptions") && request.method === "GET") {
      const id = path.split("/").at(-2)!

      return Response.json({ thread_subscriptions: subscriptions.get(id) ?? [] })
    }
    if (path.endsWith("/archive") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const row = conversations.get(id)

      if (!row) return Response.json({ error: { code: "not_found" } }, { status: 404 })

      const archived = { ...row, archived_at: now.toISOString() }

      conversations.set(id, archived)
      archivedIds.push(id)
      return Response.json({ conversation: archived })
    }
    if (path.includes("/conversations/") && request.method === "GET") {
      const id = path.split("/").at(-1)!
      const row = conversations.get(id)

      return row
        ? Response.json({ conversation: row })
        : Response.json({ error: { code: "not_found" } }, { status: 404 })
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 })
  })

  const skillDrafts = new SkillDrafts(fixture.client.profile.storeEntries, () => now)
  const inbox = new Inbox(
    fixture.client.profile.storeEntries,
    () => now,
    async () => (await skillDrafts.list()).length,
  )

  return {
    fixture,
    conversations,
    schedules,
    subscriptions,
    archivedIds,
    skillDrafts,
    inbox,
    setNow(date: Date) {
      now = date
    },
  }
}

test("partition classifies whose-turn, snooze wakes on new activity, complete honors automation", async () => {
  const { fixture, conversations, schedules, archivedIds, skillDrafts, inbox } = inboxFixture()

  try {
    schedules.push(scheduleRow({ public_id: "sched-1", conversation_public_id: "conv-auto" }))
    conversations.set(
      "conv-task",
      summaryRow({ public_id: "conv-task", title: "Draft quarterly memo", last_activity_at: "2026-11-26T12:00:00Z" }),
    )
    conversations.set(
      "conv-auto",
      summaryRow({ public_id: "conv-auto", title: "Standing PR monitor", last_activity_at: "2026-11-26T12:30:00Z" }),
    )
    await skillDrafts.propose({ name: "weekly-digest", scope: "agent", description: "desc", content: "body" })

    const initial = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(initial.sections.needs_you.map((row) => row.public_id).sort()).toEqual(["conv-auto", "conv-task"])
    expect(initial.personal_desk).toBeNull()
    expect(initial.counts).toEqual({ needs_you: 2, running: 0, snoozed: 0, done: 0, skill_drafts: 1 })

    const snoozed = await inbox.snooze({
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-task",
      until_at: "2026-11-26T16:00:00Z",
    })
    expect(snoozed).toEqual({ snoozed_until: "2026-11-26T16:00:00Z", snoozed_at: "2026-11-26T14:00:00Z" })

    const afterSnooze = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(afterSnooze.sections.snoozed.map((row) => row.public_id)).toEqual(["conv-task"])
    expect(afterSnooze.sections.snoozed[0].snoozed_until).toBe("2026-11-26T16:00:00Z")

    // New activity after snoozed_at wakes the task back to needs_you.
    conversations.set("conv-task", { ...conversations.get("conv-task")!, last_activity_at: "2026-11-26T14:05:00Z" })
    const woken = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(woken.sections.snoozed).toEqual([])
    expect(woken.sections.needs_you.map((row) => row.public_id)).toContain("conv-task")

    // Completing an automated conversation marks it read without archiving.
    const autoDone = await inbox.complete({
      client: fixture.client,
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-auto",
    })
    expect(autoDone).toMatchObject({ outcome: "returned_to_running", conversation_public_id: "conv-auto" })
    expect(archivedIds).not.toContain("conv-auto")

    // Completing a plain conversation clears its snooze and archives it into done.
    const taskDone = await inbox.complete({
      client: fixture.client,
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-task",
    })
    expect(taskDone).toEqual({ outcome: "archived", conversation_public_id: "conv-task" })
    expect(archivedIds).toContain("conv-task")

    const settled = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(settled.sections.running.map((row) => row.public_id)).toEqual(["conv-auto"])
    expect(settled.sections.running[0].reason).toBe("automation_enabled")
    expect(settled.sections.done.map((row) => row.public_id)).toEqual(["conv-task"])
    expect(settled.sections.done[0].section).toBe("done")

    // The completed plain conversation's emptied entry row is deleted from the document.
    const document = [...fixture.entries.values()].find((entry) => entry.namespace === "rho.inbox")
    expect((document?.value as { entries: JsonObject }).entries).toEqual({
      "conv-auto": { read_at: "2026-11-26T12:30:00Z" },
    })
  } finally {
    fixture.server.stop(true)
  }
})

test("the personal desk completes to marked_read and leaves sections once read", async () => {
  const { fixture, conversations, archivedIds, inbox } = inboxFixture()

  try {
    conversations.set(
      "desk-1",
      summaryRow({
        public_id: "desk-1",
        title: null,
        metadata: { "opencode.surface": "personal_desk" },
        last_activity_at: "2026-11-26T12:00:00Z",
      }),
    )

    const before = await inbox.partition({
      client: fixture.client,
      workspace_public_id: "ws-1",
      desk_public_id: "desk-1",
    })
    expect(before.personal_desk).toMatchObject({
      public_id: "desk-1",
      title: "Personal Desk",
      is_personal_desk: true,
      reason: "ready",
    })
    expect(before.sections.needs_you.map((row) => row.public_id)).toEqual(["desk-1"])

    const done = await inbox.complete({
      client: fixture.client,
      workspace_public_id: "ws-1",
      conversation_public_id: "desk-1",
    })
    expect(done).toMatchObject({ outcome: "marked_read", conversation_public_id: "desk-1" })
    expect(done.outcome === "marked_read" && done.inbox_entry).toEqual({ read_at: "2026-11-26T12:00:00Z" })
    expect(archivedIds).toEqual([])

    const after = await inbox.partition({
      client: fixture.client,
      workspace_public_id: "ws-1",
      desk_public_id: "desk-1",
    })
    expect(after.personal_desk?.public_id).toBe("desk-1")
    expect(after.sections.needs_you).toEqual([])
    expect(after.sections.running).toEqual([])
    expect(after.counts.needs_you).toBe(0)
  } finally {
    fixture.server.stop(true)
  }
})

test("indefinite snooze has no time expiry and sorts after timed snoozes", async () => {
  const { fixture, conversations, inbox, setNow } = inboxFixture()

  try {
    conversations.set("conv-a", summaryRow({ public_id: "conv-a" }))
    conversations.set("conv-b", summaryRow({ public_id: "conv-b" }))

    await inbox.snooze({ workspace_public_id: "ws-1", conversation_public_id: "conv-a", until_at: "indefinite" })
    await inbox.snooze({
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-b",
      until_at: "2026-11-26T15:00:00Z",
    })

    const partitioned = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(partitioned.sections.snoozed.map((row) => row.public_id)).toEqual(["conv-b", "conv-a"])
    expect(partitioned.sections.snoozed[1].snoozed_until).toBe(indefinite)

    // A day later the timed snooze expired back to needs_you; the indefinite one stays.
    setNow(new Date("2026-11-27T14:00:00Z"))
    const later = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(later.sections.snoozed.map((row) => row.public_id)).toEqual(["conv-a"])
    expect(later.sections.needs_you.map((row) => row.public_id)).toEqual(["conv-b"])
  } finally {
    fixture.server.stop(true)
  }
})

test("snooze validates until_at and clears on null or empty", async () => {
  const { fixture, conversations, inbox } = inboxFixture()

  try {
    conversations.set("conv-a", summaryRow({ public_id: "conv-a" }))

    await expect(
      inbox.snooze({ workspace_public_id: "ws-1", conversation_public_id: "conv-a", until_at: "2026-11-26T14:00:00Z" }),
    ).rejects.toThrow("snooze time must be in the future")
    await expect(
      inbox.snooze({ workspace_public_id: "ws-1", conversation_public_id: "conv-a", until_at: "not-a-time" }),
    ).rejects.toThrow("until_at must be an ISO-8601 timestamp, 'indefinite', or null")
    await expect(
      inbox.snooze({ workspace_public_id: "ws-1", conversation_public_id: "", until_at: null }),
    ).rejects.toThrow("conversation_public_id is required")

    await inbox.snooze({
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-a",
      until_at: "2026-11-26T16:00:00Z",
    })
    const cleared = await inbox.snooze({
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-a",
      until_at: null,
    })
    expect(cleared).toEqual({})

    const document = [...fixture.entries.values()].find((entry) => entry.namespace === "rho.inbox")
    expect((document?.value as { entries: JsonObject }).entries).toEqual({})

    const partitioned = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(partitioned.sections.snoozed).toEqual([])
    expect(partitioned.sections.needs_you.map((row) => row.public_id)).toEqual(["conv-a"])
  } finally {
    fixture.server.stop(true)
  }
})

test("snooze follows the reference Time.iso8601 grammar", async () => {
  const { fixture, conversations, inbox } = inboxFixture()

  try {
    conversations.set("conv-a", summaryRow({ public_id: "conv-a" }))

    for (const untilAt of ["2026-11-27", "2026-11-27T16:00Z"]) {
      await expect(
        inbox.snooze({ workspace_public_id: "ws-1", conversation_public_id: "conv-a", until_at: untilAt }),
      ).rejects.toThrow("until_at must be an ISO-8601 timestamp, 'indefinite', or null")
    }

    const precise = await inbox.snooze({
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-a",
      until_at: "2026-11-27T12:34:56.12345678901234567890Z",
    })
    expect(precise.snoozed_until).toBe("2026-11-27T12:34:56Z")

    const hourOffset = await inbox.snooze({
      workspace_public_id: "ws-1",
      conversation_public_id: "conv-a",
      until_at: "2026-11-27T00:00:00+08",
    })
    expect(hourOffset.snoozed_until).toBe("2026-11-26T16:00:00Z")
  } finally {
    fixture.server.stop(true)
  }
})

test("active runs and busy conversations classify by whose turn it is", async () => {
  const { fixture, conversations, inbox } = inboxFixture()

  try {
    conversations.set("conv-wait", summaryRow({ public_id: "conv-wait" }))
    conversations.set("conv-fail", summaryRow({ public_id: "conv-fail" }))
    conversations.set("conv-busy", summaryRow({ public_id: "conv-busy", active_turn_public_id: "turn-1" }))

    const partitioned = await inbox.partition({
      client: fixture.client,
      workspace_public_id: "ws-1",
      active_runs: { "conv-wait": { status: "needs_attention" }, "conv-fail": { status: "uncertain" } },
    })

    const byId = new Map(partitioned.sections.needs_you.map((row) => [row.public_id, row]))
    expect(byId.get("conv-wait")).toMatchObject({ reason: "awaiting_decision", run_status: "needs_attention" })
    expect(byId.get("conv-fail")).toMatchObject({ reason: "execution_failed", run_status: "uncertain" })
    expect(partitioned.sections.running.map((row) => row.public_id)).toEqual(["conv-busy"])
    expect(partitioned.sections.running[0].reason).toBe("working")
    expect("run_status" in partitioned.sections.running[0]).toBe(false)
  } finally {
    fixture.server.stop(true)
  }
})

test("a live thread subscription counts as automation", async () => {
  const { fixture, conversations, subscriptions, inbox } = inboxFixture()

  try {
    conversations.set("conv-sub", summaryRow({ public_id: "conv-sub", last_activity_at: "2026-11-26T12:00:00Z" }))
    subscriptions.set("conv-sub", [
      {
        public_id: "sub-1",
        conversation_public_id: "conv-sub",
        source_key: "github",
        thread_key: "t1",
        mode: "active",
        stopped_at: null,
        created_at: "2026-11-26T10:00:00Z",
      },
    ])

    const unread = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(unread.sections.needs_you.map((row) => row.public_id)).toEqual(["conv-sub"])

    await inbox.markRead({ workspace_public_id: "ws-1", conversation_public_id: "conv-sub" })
    const read = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(read.sections.running.map((row) => row.public_id)).toEqual(["conv-sub"])
    expect(read.sections.running[0].reason).toBe("automation_enabled")
  } finally {
    fixture.server.stop(true)
  }
})

test("side and subagent conversations are skipped", async () => {
  const { fixture, conversations, inbox } = inboxFixture()

  try {
    conversations.set("conv-side", summaryRow({ public_id: "conv-side", side: true }))
    conversations.set(
      "conv-subagent",
      summaryRow({
        public_id: "conv-subagent",
        parent: { public_id: "conv-parent", spawn_node_key: null, label: null },
        taken_over_at: null,
      }),
    )
    conversations.set("conv-task", summaryRow({ public_id: "conv-task" }))

    const partitioned = await inbox.partition({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(partitioned.sections.needs_you.map((row) => row.public_id)).toEqual(["conv-task"])
    expect(partitioned.counts.needs_you).toBe(1)
  } finally {
    fixture.server.stop(true)
  }
})
