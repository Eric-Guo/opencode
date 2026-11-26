import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { Channels } from "../src/channels"
import { checkInPrefix, doesForWake, preparePrompt, Routines, wakeForDoes } from "../src/routines"
import { storeFixture } from "./fixture/store"

function scheduleRow(fields: JsonObject): JsonObject {
  return {
    public_id: "sched-1",
    workspace_public_id: "ws-1",
    name: null,
    prompt: "Check inbox",
    rule: { kind: "daily", local_time: "09:00" },
    wake: "auto",
    status: "active",
    lock_version: 1,
    next_run_at: null,
    conversation_public_id: null,
    ...fields,
  }
}

function routinesFixture(schedules: JsonObject[]) {
  const fixture = storeFixture((request) => {
    const url = new URL(request.url)

    if (url.pathname.endsWith("/schedules") && request.method === "GET")
      return Response.json({ schedules, pagination: { next_after: null } })
    return undefined
  })
  const channels = new Channels(fixture.client.profile.storeEntries)
  const routines = new Routines(channels)

  return { fixture, channels, routines }
}

test("routines unify time and event triggers into four-part rows", async () => {
  const { fixture, channels, routines } = routinesFixture([
    scheduleRow({
      public_id: "sched-1",
      conversation_public_id: "conv-auto",
      name: "Morning Check",
      prompt: checkInPrefix + "Check inbox",
      wake: "passive",
      next_run_at: "2026-11-27T09:00:00Z",
    }),
  ])

  try {
    await channels.upsertSource({
      source_key: "github",
      name: "GitHub",
      accept_mode: "auto",
      allowed_senders: ["alice"],
    })
    await channels.createEventRoutine({
      name: "PR Watch",
      source_key: "github",
      pattern: "review_requested",
      instructions: "Inspect PR diff.",
      does: "act",
    })

    const unified = await routines.list({ client: fixture.client, workspace_public_id: "ws-1" })
    expect(unified.routines).toHaveLength(2)
    expect(unified.time_routines).toHaveLength(1)
    expect(unified.event_routines).toHaveLength(1)
    expect(unified.routines).toEqual([...unified.time_routines, ...unified.event_routines])

    const time = unified.time_routines[0]
    expect(time).toMatchObject({
      kind: "time",
      public_id: "sched-1",
      conversation_public_id: "conv-auto",
      name: "Morning Check",
      what: "Check inbox",
      does: "check_in",
      wake: "passive",
      status: "active",
      enabled: true,
      lock_version: 1,
      next_run_at: "2026-11-27T09:00:00Z",
    })
    expect(time.starts).toMatchObject({ kind: "daily", local_time: "09:00" })

    const event = unified.event_routines[0]
    expect(event).toMatchObject({
      kind: "event",
      name: "PR Watch",
      what: "Inspect PR diff.",
      starts: { type: "event", source_key: "github", pattern: "review_requested" },
      does: "act",
      accept_mode: "auto",
      status: "active",
      enabled: true,
    })
    expect(unified.attention_policy.daily_proactive_limit).toBe(10)
    expect(unified.observations).toEqual([])
  } finally {
    fixture.server.stop(true)
  }
})

test("time routines without a name fall back to the prompt's first line", async () => {
  const longLine = "Review the nightly build results and summarize regressions for the team before standup tomorrow"
  const { fixture, routines } = routinesFixture([
    scheduleRow({ public_id: "sched-2", prompt: checkInPrefix + longLine + "\nSecond line", wake: "auto" }),
  ])

  try {
    const unified = await routines.list({ client: fixture.client, workspace_public_id: "ws-1" })
    const time = unified.time_routines[0]

    expect(time.name).toBe(longLine.slice(0, 60))
    expect(time.what).toBe(longLine + "\nSecond line")
    expect(time.does).toBe("act")
    expect("next_run_at" in time).toBe(false)
    expect("conversation_public_id" in time).toBe(false)
  } finally {
    fixture.server.stop(true)
  }
})

test("event routines project accept_mode and status from their source", async () => {
  const { fixture, channels, routines } = routinesFixture([])

  try {
    await channels.upsertSource({ source_key: "github", name: "GitHub", accept_mode: "observe" })
    await channels.createEventRoutine({
      name: "Observe Rule",
      source_key: "github",
      instructions: "Watch.",
      does: "check_in",
    })
    await channels.createEventRoutine({
      name: "Wildcard Rule",
      source_key: "*",
      instructions: "Watch all.",
      does: "act",
    })
    await channels.createEventRoutine({
      name: "Paused Rule",
      source_key: "github",
      instructions: "Paused.",
      does: "act",
      enabled: false,
    })

    const unified = await routines.list({ client: fixture.client, workspace_public_id: "ws-1" })
    const byName = new Map(unified.event_routines.map((row) => [row.name, row]))

    expect(byName.get("Observe Rule")).toMatchObject({ accept_mode: "observe", status: "observe", enabled: true })
    expect(byName.get("Wildcard Rule")).toMatchObject({
      accept_mode: "observe",
      status: "observe",
      starts: { type: "event", source_key: "*" },
    })
    expect(byName.get("Wildcard Rule")?.starts).not.toHaveProperty("pattern")
    expect(byName.get("Paused Rule")).toMatchObject({ status: "paused", enabled: false })
  } finally {
    fixture.server.stop(true)
  }
})

test("does and wake map onto each other and the check-in prefix is applied once", () => {
  expect(doesForWake("passive")).toBe("check_in")
  expect(doesForWake("auto")).toBe("act")
  expect(doesForWake(undefined)).toBe("act")
  expect(wakeForDoes("check_in")).toBe("passive")
  expect(wakeForDoes("act")).toBe("auto")
  expect(wakeForDoes(undefined)).toBe("auto")

  const prefixed = preparePrompt("Check inbox", "check_in")
  expect(prefixed).toBe(checkInPrefix + "Check inbox")
  expect(preparePrompt(prefixed, "check_in")).toBe(prefixed)
  expect(preparePrompt("  Check inbox  ", "act")).toBe("Check inbox")
})
