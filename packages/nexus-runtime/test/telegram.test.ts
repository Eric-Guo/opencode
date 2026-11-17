import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { TelegramSettings } from "../src/telegram-settings"
import { TelegramUpdate } from "../src/telegram-update"
import { TelegramIngress } from "../src/telegram-ingress"
import { TelegramState, telegramState } from "../src/telegram-state"
import { telegramSetup } from "../src/telegram-setup"
import { telegramRule, telegramTime } from "../src/telegram-schedules"
import { telegramChunks } from "../src/telegram-api"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

const connection = "00000000-0000-4000-8000-000000000001"
const bot = "00000000-0000-4000-8000-000000000002"
const second = "00000000-0000-4000-8000-000000000003"
const now = 1700000000000

function fixture(group = true) {
  const state = {
    physical: 123,
    loseInput: false,
    rateLimited: false,
    uncertainSend: false,
    terminal: false,
    running: false,
    formatting: false,
    loseSchedule: false,
    changedVariant: false,
    inference: 0,
  }
  const sent: JsonObject[] = []
  const previews: JsonObject[] = []
  const inputs: { key: string; body: JsonObject; conversation: string }[] = []
  const requests: string[] = []
  const schedules: { key: string; body: JsonObject; path: string }[] = []
  const scheduleEdits: JsonObject[] = []
  const service = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path.endsWith("/models"))
      return Response.json({
        models: [
          {
            ref: "provider/available",
            provider: "provider",
            workload: "text_generation",
            visible: true,
            available: true,
          },
        ],
      })
    if (path.endsWith("/getMe"))
      return Response.json({ ok: true, result: { id: state.physical, username: "FixtureBot", is_bot: true } })
    if (path.endsWith("/getUpdates")) return Response.json({ ok: true, result: [] })
    if (path.endsWith("/getFile"))
      return Response.json({ ok: true, result: { file_path: "files/oversized", file_size: 21 * 1024 * 1024 } })
    if (["/setMyCommands", "/sendChatAction"].some((method) => path.endsWith(method)))
      return Response.json({ ok: true, result: true })
    if (path.endsWith("/sendMessageDraft")) {
      previews.push((await request.json()) as JsonObject)
      return Response.json({ ok: true, result: true })
    }
    if (path.endsWith("/stop")) return Response.json({ run: { public_id: "run", status: "canceled" } })
    if (path.endsWith("/sendMessage")) {
      sent.push((await request.json()) as JsonObject)
      if (state.formatting) {
        state.formatting = false
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
          { status: 400 },
        )
      }
      if (state.rateLimited) {
        state.rateLimited = false
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, { status: 429 })
      }
      if (state.uncertainSend) {
        state.uncertainSend = false
        return new Response("incomplete", { status: 200 })
      }
      return Response.json({ ok: true, result: { message_id: 1000 + sent.length } })
    }
    if (path.endsWith("/schedules") && request.method === "POST") {
      const body = ((await request.json()) as { schedule: JsonObject }).schedule
      schedules.push({ key: request.headers.get("idempotency-key")!, body, path })
      if (state.loseSchedule) {
        state.loseSchedule = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json(
        {
          schedule: { ...body, public_id: "job", workspace_public_id: "workspace", status: "active", lock_version: 0 },
        },
        { status: 201 },
      )
    }
    if (path.endsWith("/schedules/job")) {
      if (request.method === "PATCH") scheduleEdits.push(((await request.json()) as { schedule: JsonObject }).schedule)
      return Response.json({
        schedule: {
          ...schedules.at(-1)?.body,
          ...scheduleEdits.at(-1),
          public_id: "job",
          workspace_public_id: "workspace",
          status: "active",
          lock_version: scheduleEdits.length,
        },
      })
    }
    if (path.endsWith("/schedules/job/pause"))
      return Response.json({
        schedule: {
          public_id: "job",
          workspace_public_id: "workspace",
          prompt: "Job",
          rule: { kind: "interval", every_seconds: 60 },
          status: "paused",
          lock_version: 1,
        },
      })
    if (path.endsWith("/schedules/job/executions"))
      return Response.json({ executions: [], pagination: { next_after: null } })
    if (path.endsWith("/workspaces"))
      return Response.json({
        workspaces: [
          {
            public_id: "workspace",
            name: "Home",
            state: "active",
            dedicated: false,
            default: false,
            created_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
          },
        ],
        pagination: { next_after: null },
      })
    if (path.endsWith("/children")) return Response.json({ conversations: [], pagination: { next_after: null } })
    if (path.endsWith("/memory")) return Response.json({ memory: [] })
    if (path.endsWith("/turns"))
      return Response.json({
        turns: [
          {
            public_id: "turn",
            position: 1,
            kind: "message",
            role: "user",
            status: "completed",
            visibility: "visible",
            created_at: new Date(now).toISOString(),
            answering_user_public_id: bot,
            active_variant: {
              public_id: "variant",
              source: "original",
              status: "completed",
              content: "A relevant observed discussion",
              run_public_id: null,
            },
          },
        ],
        pagination: { before_position: null, after_position: null },
      })
    if (path.endsWith("/inference_requests") && request.method === "POST") {
      state.inference++
      return Response.json(
        {
          inference_request: {
            public_id: "inference",
            workload: "text_generation",
            status: "completed",
            model: { provider_id: "provider", model_ref: "original" },
            created_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
            usage_summary: {
              request_count: 1,
              input_tokens: 1,
              cache_read_tokens: 0,
              uncached_input_tokens: 1,
              cache_creation_tokens: 0,
              output_tokens: 1,
              reasoning_tokens: 0,
              total_tokens: 2,
              cost_amount: "0",
              cost_complete: true,
            },
            result: {
              status: "completed",
              output_text: JSON.stringify({ decision: "reply", text: "A useful brief reply." }),
            },
          },
        },
        { status: 202 },
      )
    }
    if (path.endsWith("/profile/agents"))
      return Response.json({
        agents: [
          {
            public_id: bot,
            name: "bot-fixture",
            scope: "instance",
            handle: "@fixture",
            agent_identifier: "fixture",
            steward_public_id: "owner",
            kind: "agent",
            derived_from_public_id: "main",
            description: "Fixture Bot",
            configuration: {
              tool_definitions: [],
              kernel_tools: [],
              runner_executor_public_ids: [],
              mcp_tools: [],
              fallback_models: [],
            },
          },
        ],
      })
    if (path.endsWith("/tools")) return Response.json({ tools: [] })
    if (path.endsWith("/ingress_speakers")) {
      const body = (await request.json()) as { ingress_speaker: JsonObject }
      return Response.json(
        {
          ingress_speaker: {
            ...body.ingress_speaker,
            public_id: "speaker-" + body.ingress_speaker.external_id,
            kind: "ingress",
          },
        },
        { status: 201 },
      )
    }
    if (path.endsWith("/conversations/conversation") || path.endsWith("/conversations/new-conversation"))
      return Response.json({
        conversation: conversationFixture({
          public_id: path.split("/").at(-1)!,
          answering_user_public_id: bot,
          metadata: { "opencode.bot": bot },
        }),
      })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      inputs.push({
        key: request.headers.get("idempotency-key")!,
        body: body.input,
        conversation: path.split("/").at(-2)!,
      })
      if (state.loseInput) {
        state.loseInput = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json(
        { input: inputFixture({ ...body.input, public_id: request.headers.get("idempotency-key")! }) },
        { status: 202 },
      )
    }
    if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
    if (path.endsWith("/materialization"))
      return state.terminal || state.running
        ? Response.json({
            materialization: {
              input_public_id: path.split("/").at(-2),
              turn_public_id: "turn",
              variant_public_id: "variant",
              run_public_id: "run",
            },
          })
        : Response.json({ error: { code: "not_found" } }, { status: 404 })
    if (path.endsWith("/turns/turn"))
      return Response.json({
        turn: {
          public_id: "turn",
          input_public_id: "input",
          position: 1,
          kind: "direct_reply",
          role: "assistant",
          status: state.terminal ? "completed" : "running",
          visibility: "visible",
          created_at: new Date(now).toISOString(),
          answering_user_public_id: bot,
          active_variant: {
            public_id: state.changedVariant ? "replacement" : "variant",
            source: "original",
            status: state.terminal ? "completed" : "running",
            content: "The result belongs to the original conversation.",
            run_public_id: "run",
          },
        },
      })
    if (path.endsWith("/turns/turn/variants"))
      return Response.json({
        turn: { public_id: "turn", inherited: false },
        variants: [
          {
            public_id: "variant",
            source: "original",
            status: state.terminal ? "completed" : "running",
            content: "The result belongs to the original conversation.",
            run_public_id: "run",
          },
        ],
      })
    if (path.endsWith("/runs/run"))
      return Response.json({
        run: {
          public_id: "run",
          status: state.terminal ? "completed" : "running",
          tasks: state.running
            ? [
                {
                  key: "model",
                  kind: "model_task",
                  status: "running",
                  lifetime: "run",
                  wake: "foreground",
                  after: [],
                  waiting_on: [],
                },
              ]
            : [],
        },
      })
    if (path.includes("/store_entries")) return
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 })
  })
  const seed = (namespace: string, key: string, value: unknown) => {
    const id = crypto.randomUUID()
    service.entries.set(id, {
      public_id: id,
      namespace,
      key,
      value: Schema.decodeUnknownSync(Schema.MutableJson)(value),
      lock_version: 0,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    return id
  }
  seed("opencode.bots", bot, {
    audience: group ? "external" : "owner",
    home_workspace_public_id: "workspace",
    preset_public_id: "preset",
    welcome_message: null,
    subagent: false,
  })
  seed("opencode.presets", "catalog", {
    presets: [{ public_id: "preset", name: "Fixture", description: "Fixture preset", role: null, configuration: {} }],
    main_preset_public_id: "preset",
    default_bot_preset_public_id: "preset",
  })
  const current = seed("opencode.bot-conversations", bot, {
    current: { public_id: "conversation", workspace_public_id: "workspace" },
    receipts: {},
  })
  seed("opencode.telegram.bot", bot, {
    ...telegramState(),
    observe: true,
    access: { allowed_users: ["20", "30"], allowed_chats: ["-100"], ignored_users: [] },
  })
  const config = {
    connections: { [connection]: { token: "fixture-token" } },
    bots: {
      [bot]: {
        enabled: true,
        connection_public_id: connection,
        target: { chat_id: group ? "-100" : "10" },
        owner_id: "10",
        input_debounce_seconds: 2,
      },
    },
  }
  const open = () => {
    const app = new NexusApplication(
      service.client,
      { workspace: "workspace", agent: "main", runner: "runner" },
      () => ({ default_model: "provider/original" }),
    )
    return new TelegramIngress(config, {
      application: () => app,
      signal: AbortSignal.timeout(10000),
      origin: service.server.url.origin,
    })
  }
  const saved = () =>
    Schema.decodeUnknownSync(TelegramState)(
      [...service.entries.values()].find((entry) => entry.namespace === "opencode.telegram.bot")!.value,
    )
  return {
    ...service,
    sent,
    previews,
    inputs,
    requests,
    schedules,
    scheduleEdits,
    state,
    config,
    current,
    open,
    saved,
    [Symbol.dispose]() {
      service.server.stop(true)
    },
  }
}

function message(id: number, text: string, fields: JsonObject = {}) {
  return {
    update_id: id,
    message: {
      message_id: id + 100,
      date: now / 1000,
      from: { id: 20, first_name: "Requester", is_bot: false },
      chat: { id: -100, type: "supergroup" },
      text,
      ...fields,
    },
  }
}

test("Telegram rejects duplicate tokens and target reuse, including disabled bindings", () => {
  expect(
    () =>
      new TelegramSettings({
        connections: { [connection]: { token: "one" }, [second]: { token: "one", enabled: false } },
      }),
  ).toThrow("token")
  expect(
    () =>
      new TelegramSettings({
        connections: { [connection]: {} },
        bots: {
          [bot]: { connection_public_id: connection, target: { chat_id: "-100" } },
          [second]: { enabled: false, connection_public_id: connection, target: { chat_id: "-100" } },
        },
      }),
  ).toThrow("already bound")
  expect(
    () =>
      new TelegramSettings({
        connections: { [connection]: {} },
        bots: { [bot]: { connection_public_id: connection, target: { chat_id: "20", topic_id: 5 } } },
      }),
  ).toThrow("group")
})

test("Telegram distinguishes topics from ordinary replies and uses UTF-16 mention offsets", () => {
  const update = new TelegramUpdate(
    message(1, "😀 @FixtureBot hi", { message_thread_id: 55, entities: [{ type: "mention", offset: 3, length: 11 }] }),
  )
  expect(update.topic).toBeNull()
  expect(update.mentions({ id: "123", username: "fixturebot" })).toBe(true)
  expect(new TelegramUpdate(message(2, "hi", { message_thread_id: 55, is_topic_message: true })).topic).toBe(55)
  const chunks = telegramChunks("😀".repeat(3000))
  expect(chunks.map((text) => text.length)).toEqual([4096, 1904])
  expect(chunks.join("")).toBe("😀".repeat(3000))
})

test("Telegram debounces only compatible requester messages and persists before admission", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot first", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  await ingress.ingest(
    connection,
    message(2, "@FixtureBot second", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now + 1000,
  )
  expect(peer.saved().batches).toHaveLength(1)
  expect(peer.saved().batches[0].sources).toHaveLength(2)
  expect(peer.inputs).toHaveLength(0)
  await ingress.tick(connection, now + 2999)
  expect(peer.inputs).toHaveLength(0)
  const restored = peer.open()
  await restored.tick(connection, now + 3000)
  expect(peer.inputs).toHaveLength(1)
  expect(peer.inputs[0].body).toMatchObject({
    text: "@FixtureBot first\n\n@FixtureBot second",
    speaker_public_id: "speaker-20",
    delivery_mode: "queue",
    kind: "direct_reply",
  })
  expect(peer.saved().batches).toHaveLength(0)
})

test("Telegram captures observations without triggering a reply and isolates requesters", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "background context"), now)
  await ingress.ingest(
    connection,
    message(2, "other requester", { from: { id: 30, first_name: "Other", is_bot: false } }),
    now + 1,
  )
  expect(peer.saved().batches).toHaveLength(2)
  await ingress.tick(connection, now + 3000)
  expect(peer.inputs[0].body).toMatchObject({ kind: "message", speaker_public_id: "speaker-20" })
  expect(peer.saved().work[0].terminal).toBe(true)
  await ingress.tick(connection, now + 3001)
  expect(peer.inputs[1].body).toMatchObject({ kind: "message", speaker_public_id: "speaker-30" })
})

test("Telegram replays frozen admissions after a lost response without absorbing later text", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "first"), now)
  peer.state.loseInput = true
  await expect(ingress.tick(connection, now + 2000)).rejects.toThrow()
  expect(peer.saved().batches[0].submission).toBeDefined()
  await ingress.ingest(connection, message(2, "later"), now + 2001)
  expect(peer.saved().batches).toHaveLength(2)
  const restored = peer.open()
  await restored.tick(connection, now + 2002)
  expect(peer.inputs).toHaveLength(2)
  expect(peer.inputs[1]).toEqual(peer.inputs[0])
  expect(peer.saved().batches[0].sources[0].text).toBe("later")
})

test("Telegram ignores stale messages, unallowed people and different targets", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "stale", { date: now / 1000 - 601 }), now)
  await ingress.ingest(connection, message(2, "stranger", { from: { id: 99, first_name: "Stranger" } }), now)
  await ingress.ingest(connection, message(3, "different chat", { chat: { id: -200, type: "group" } }), now)
  await ingress.ingest(
    connection,
    message(4, "different topic", { is_topic_message: true, message_thread_id: 77 }),
    now,
  )
  expect(peer.saved().batches).toHaveLength(0)
  expect(peer.inputs).toHaveLength(0)
})

test("Telegram physical identity changes cannot reuse the old polling offset", async () => {
  using peer = fixture()
  await peer.open().identity(connection)
  const row = [...peer.entries.values()].find((entry) => entry.namespace === "opencode.telegram.connection")!
  peer.entries.set(row.public_id, { ...row, value: { identity: { id: "123", username: "FixtureBot" }, offset: 500 } })
  peer.state.physical = 456
  await expect(peer.open().identity(connection)).rejects.toThrow("another physical")
  expect(peer.entries.get(row.public_id)!.value).toHaveProperty("offset", 500)
})

test("Telegram requester Stop removes only the replied-to unadmitted source", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "one"), now)
  await ingress.ingest(connection, message(2, "two"), now + 1)
  await ingress.ingest(
    connection,
    message(3, "/stop@FixtureBot", {
      reply_to_message: { message_id: 101 },
      entities: [{ type: "mention", offset: 5, length: 11 }],
    }),
    now + 2,
  )
  expect(peer.saved().batches[0].sources.map((row) => row.text)).toEqual(["two"])
})

test("Telegram rate limits retry at the receipt deadline and uncertain sends require explicit retry", async () => {
  using peer = fixture(false)
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "/status", { chat: { id: 10, type: "private" }, from: { id: 10, first_name: "Owner" } }),
    now,
  )
  peer.state.rateLimited = true
  await ingress.tick(connection, now)
  expect(peer.saved().deliveries[0]).toMatchObject({ status: "pending", retry: now + 3000 })
  await ingress.tick(connection, now + 2999)
  expect(peer.sent).toHaveLength(1)
  peer.state.uncertainSend = true
  await ingress.tick(connection, now + 3000)
  expect(peer.saved().deliveries[0].status).toBe("uncertain")
  const restored = peer.open()
  await restored.tick(connection, now + 6000)
  expect(peer.sent).toHaveLength(2)
  await restored.command({ action: "telegram.delivery.retry", id: bot, delivery: peer.saved().deliveries[0].id })
  await restored.tick(connection, now + 6000)
  expect(peer.sent).toHaveLength(3)
  expect(peer.saved().deliveries[0].status).toBe("sent")
})

test("Telegram final delivery retains the accepted conversation after a current switch", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot fix", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  await ingress.tick(connection, now + 2000)
  const entry = peer.entries.get(peer.current)!
  peer.entries.set(peer.current, {
    ...entry,
    value: { current: { public_id: "new-conversation", workspace_public_id: "workspace" }, receipts: {} },
  })
  peer.state.terminal = true
  await peer.open().tick(connection, now + 3000)
  expect(peer.sent[0]).toMatchObject({ chat_id: "-100", text: "The result belongs to the original conversation." })
  expect(peer.saved().deliveries[0].target?.conversation).toBe("conversation")
  expect(peer.requests.some((path) => path.includes("new-conversation/events"))).toBe(false)
})

test("Telegram Connection setup preserves omitted secrets and validates before saving", async () => {
  const settings = new TelegramSettings({
    connections: { [connection]: { token: "private-token", name: "Original" } },
    bots: {},
  })
  const writes: unknown[] = []
  const configure = async (value: unknown) => {
    writes.push(value)
  }
  const result = await telegramSetup(
    { action: "telegram.connection.save", id: connection, name: "Renamed" },
    settings,
    configure,
  )
  expect(JSON.stringify(result)).not.toContain("private-token")
  expect(writes[0]).toMatchObject([{ value: { token: "private-token", name: "Renamed" } }])
  await expect(
    telegramSetup({ action: "telegram.connection.save", id: second, token: "private-token" }, settings, configure),
  ).rejects.toThrow("already configured")
  expect(writes).toHaveLength(1)
  await expect(
    telegramSetup({ action: "telegram.connection.save", id: connection, token: "" }, settings, configure),
  ).rejects.toThrow("Omit token")
})

test("Telegram scheduling resolves the saved clock and requires explicit absolute-time offsets", () => {
  expect(telegramTime("in 20m", now)).toBe(new Date(now + 1200000).toISOString())
  expect(telegramRule("every 1h Check the build", now)).toEqual({
    rule: { kind: "interval", every_seconds: 3600, starts_at: new Date(now + 3600000).toISOString() },
    prompt: "Check the build",
  })
  expect(telegramRule("daily 09:00 Australia/Perth Morning report", now)).toEqual({
    rule: { kind: "daily", local_time: "09:00", time_zone: "Australia/Perth" },
    prompt: "Morning report",
  })
  expect(() => telegramTime("at 2026-11-15T09:00:00", now)).toThrow("UTC offset")
  expect(() => telegramRule("every 0s Impossible", now)).toThrow("positive")
})

test("Telegram time arguments match the reference grammar without discarding trailing text", () => {
  expect(telegramTime("in 0s", now)).toBe(new Date(now).toISOString())
  expect(telegramTime("at 2026-11-17T09:30:00+0800", now)).toBe("2026-11-17T01:30:00.000Z")
  for (const text of ["in 1m ignored", "now ignored", "at 2026-11-17T09:30Z", "at 2026-11-17T09:30:00Z ignored"])
    expect(() => telegramTime(text, now)).toThrow()
})

test("Telegram scheduled prompts retain newlines and spacing through ingress", async () => {
  using peer = fixture()
  await peer.open().ingest(connection, message(1, "/job create every 1m First line\n  second  line"), now)
  expect(peer.schedules[0].body.prompt).toBe("First line\n  second  line")
  await peer.open().ingest(connection, message(2, "/job edit job prompt Updated\n  second  line"), now + 1)
  expect(peer.scheduleEdits[0]).toEqual({ prompt: "Updated\n  second  line", expected_lock_version: 0 })
  await peer.open().ingest(connection, message(3, "/job pause job ignored"), now + 2)
  expect(peer.requests.filter((path) => path.endsWith("/schedules/job/pause"))).toEqual([])
})

test("Telegram reminders freeze the due time before admission and survive restart", async () => {
  using peer = fixture(false)
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "/remind in 20m Check the build", {
      chat: { id: 10, type: "private" },
      from: { id: 10, first_name: "Owner" },
    }),
    now,
  )
  expect(peer.saved().batches[0].submission).toMatchObject({
    deliver_at: new Date(now + 1200000).toISOString(),
    text: "Please remind me now: Check the build",
  })
  await peer.open().tick(connection, now + 5000)
  expect(peer.inputs[0].body).toMatchObject({ deliver_at: new Date(now + 1200000).toISOString() })
})

test("Telegram active participation uses a settled observed source and records only one sent reply", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/mode active", { from: { id: 10, first_name: "Owner" } }), now)
  await ingress.ingest(connection, message(2, "A relevant group discussion"), now + 1)
  await ingress.tick(connection, now + 2001)
  expect(peer.saved()).toMatchObject({
    mode: "active",
    observe: true,
    participation: { source: { update: 2, at: now + 2001 } },
  })
  peer.state.terminal = true
  await ingress.tick(connection, now + 7000)
  expect(peer.state.inference).toBe(0)
  await ingress.tick(connection, now + 7001)
  expect(peer.state.inference).toBe(1)
  expect(peer.sent.some((row) => row.text === "A useful brief reply.")).toBe(true)
  await peer.open().tick(connection, now + 7002)
  expect(peer.inputs.at(-1)?.body).toMatchObject({ kind: "message", role: "assistant", text: "A useful brief reply." })
  expect(peer.sent.filter((row) => row.text === "A useful brief reply.")).toHaveLength(1)
})

test("Telegram retires refused media so a later source can be admitted", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot inspect", {
      entities: [{ type: "mention", offset: 0, length: 11 }],
      document: { file_id: "oversized", file_name: "report.txt", mime_type: "text/plain" },
    }),
    now,
  )
  await ingress.ingest(
    connection,
    message(2, "@FixtureBot later", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now + 1,
  )
  await ingress.tick(connection, now + 2000)
  expect(peer.saved().batches).toHaveLength(1)
  expect(peer.sent.some((row) => String(row.text).includes("20 MiB"))).toBe(true)
  await ingress.tick(connection, now + 2001)
  expect(peer.inputs).toHaveLength(1)
  expect(peer.inputs[0].body.text).toBe("@FixtureBot later")
})

test("Telegram never resubmits an uncertain admission after the idempotency receipt expires", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot once", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  peer.state.loseInput = true
  await expect(ingress.tick(connection, now + 2000)).rejects.toThrow()
  await peer.open().tick(connection, now + 86400000)
  expect(peer.inputs).toHaveLength(1)
  expect(peer.saved().batches).toHaveLength(0)
  expect(peer.sent.some((row) => String(row.text).includes("receipt expired"))).toBe(true)
})

test("Telegram active participation discards an unsent candidate after the Bot current changes", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/mode active", { from: { id: 10, first_name: "Owner" } }), now)
  await ingress.ingest(connection, message(2, "a relevant observed discussion"), now + 1)
  await ingress.tick(connection, now + 2001)
  const row = peer.entries.get(peer.current)!
  peer.entries.set(peer.current, {
    ...row,
    value: { current: { public_id: "new-conversation", workspace_public_id: "workspace" }, receipts: {} },
    lock_version: row.lock_version + 1,
  })
  peer.state.terminal = true
  await peer.open().tick(connection, now + 7001)
  expect(peer.state.inference).toBe(0)
  expect(peer.sent.some((row) => row.text === "A useful brief reply.")).toBe(false)
})

test("Telegram rejects stale draft stops and keeps exact ownership through restart", async () => {
  using peer = fixture(false)
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "A private request", { chat: { id: 10, type: "private" }, from: { id: 10, is_bot: false } }),
    now,
  )
  peer.state.running = true
  await ingress.tick(connection, now + 2000)
  const draft = peer.saved().work[0].draft!
  expect(peer.previews[0]).toMatchObject({
    draft_id: draft.id,
    can_stop: true,
    text: "Working on your request.\nNow: Thinking",
  })
  await ingress.tick(connection, now + 3000)
  expect(peer.previews).toHaveLength(1)
  expect(peer.requests.filter((path) => path.endsWith("/sendChatAction"))).toHaveLength(1)
  const restored = peer.open()
  await restored.ingest(
    connection,
    { update_id: 2, stopped_message_generation: { draft_id: draft.id + 1, chat: { id: 10, type: "private" } } },
    now + 3000,
  )
  expect(peer.requests.filter((path) => path.endsWith("/stop"))).toHaveLength(0)
  await restored.ingest(
    connection,
    { update_id: 3, stopped_message_generation: { draft_id: draft.id, chat: { id: 10, type: "private" } } },
    now + 3000,
  )
  expect(peer.requests.filter((path) => path.endsWith("/stop"))).toHaveLength(1)
  peer.state.terminal = true
  await restored.tick(connection, now + 7000)
  await restored.tick(connection, now + 11000)
  expect(peer.previews).toHaveLength(1)
  expect(peer.sent.filter((body) => String(body.text).includes("The result belongs"))).toHaveLength(1)
})

test("Telegram explicitly refused HTML falls back to the captured visible chunk", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot reply", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  peer.state.terminal = true
  peer.state.formatting = true
  await ingress.tick(connection, now + 2000)
  expect(peer.sent[0].parse_mode).toBe("HTML")
  expect(peer.saved().deliveries[0]).toMatchObject({ status: "pending", plain: true })
  await peer.open().tick(connection, now + 2001)
  expect(peer.sent[1].parse_mode).toBeUndefined()
  expect(peer.sent[1].text).toBe(peer.sent[0].text)
  await peer.open().tick(connection, now + 6000)
  expect(peer.saved().deliveries).toHaveLength(0)
  expect(peer.saved().messages?.[0]).toMatchObject({ kind: "answer", input: peer.inputs[0].key, text: "" })
})

test("Telegram freezes scheduled job creation across a lost response and allows only its requester or owner to manage it", async () => {
  using peer = fixture()
  const update = message(1, "/job create every 1m Check the build")
  peer.state.loseSchedule = true
  await expect(peer.open().ingest(connection, update, now)).rejects.toThrow()
  const row = peer.entries.get(peer.current)!
  peer.entries.set(peer.current, {
    ...row,
    lock_version: row.lock_version + 1,
    value: { current: { public_id: "new-conversation", workspace_public_id: "workspace" }, receipts: {} },
  })
  await peer.open().ingest(connection, update, now + 10000)
  expect(peer.schedules).toHaveLength(2)
  expect(peer.schedules[1]).toEqual(peer.schedules[0])
  expect(peer.schedules[0].body.rule).toMatchObject({ starts_at: new Date(now + 60000).toISOString() })
  expect(peer.saved().jobs?.[0]).toMatchObject({ id: "job", requester: "20", target: { conversation: "conversation" } })
  await peer.open().ingest(connection, message(2, "/job pause job", { from: { id: 30, is_bot: false } }), now + 11000)
  expect(peer.requests.some((path) => path.endsWith("/schedules/job/pause"))).toBe(false)
  await peer.open().ingest(connection, message(3, "/job pause job"), now + 12000)
  expect(peer.requests.filter((path) => path.endsWith("/schedules/job/pause"))).toEqual([
    "/agent_api/v1/workspaces/workspace/conversations/conversation/schedules/job/pause",
  ])
})

test("Telegram refuses an unsent result after its selected source variant changes", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot answer", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  peer.state.terminal = true
  peer.state.rateLimited = true
  await ingress.tick(connection, now + 2000)
  peer.state.changedVariant = true
  await peer.open().tick(connection, now + 6000)
  expect(peer.sent).toHaveLength(1)
  expect(peer.saved().deliveries[0]).toMatchObject({ status: "refused", error: "source_unavailable" })
})

test("Telegram can export a completed result after pruning its sent payload, once per destination", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot answer", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  peer.state.terminal = true
  await ingress.tick(connection, now + 2000)
  await peer.open().tick(connection, now + 6000)
  const row = [...peer.entries.values()].find((row) => row.namespace === "opencode.telegram.bot")!
  const state = peer.saved()
  expect(state.deliveries).toHaveLength(0)
  peer.entries.set(row.public_id, {
    ...row,
    lock_version: row.lock_version + 1,
    value: Schema.decodeUnknownSync(Schema.MutableJson)({
      ...state,
      access: { ...state.access, allowed_chats: ["-100", "-200"] },
      work: [
        ...state.work,
        {
          ...state.work[0],
          id: "destination",
          input: "destination-input",
          route: { ...state.work[0].route, chat: "-200" },
        },
      ],
    }),
  })
  const command = "/deliver " + state.work[0].input + " -200:0"
  const owner = { from: { id: 10, is_bot: false } }
  const first = peer.open()
  await first.ingest(connection, message(2, command, owner), now + 7000)
  await first.tick(connection, now + 7000)
  expect(peer.sent.filter((body) => body.chat_id === "-200")).toHaveLength(1)
  await peer.open().tick(connection, now + 11000)
  const again = peer.open()
  await again.ingest(connection, message(3, command, owner), now + 12000)
  await again.tick(connection, now + 12000)
  expect(peer.sent.filter((body) => body.chat_id === "-200")).toHaveLength(1)
})

test("Telegram checks model availability before changing future-input selection", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/model provider/missing", { from: { id: 10, is_bot: false } }), now)
  expect(peer.saved().model).toBeUndefined()
  expect(peer.saved().deliveries.some((row) => row.text.includes("not available"))).toBe(true)
  await ingress.ingest(
    connection,
    message(2, "/model provider/available", { from: { id: 10, is_bot: false } }),
    now + 1000,
  )
  expect(peer.saved().model).toBe("provider/available")
})

test("Telegram conversation history commands find sessions beyond the first API page", async () => {
  const pages: string[] = []
  const store = storeFixture(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/profile/agents"))
      return Response.json({
        agents: [
          {
            public_id: bot,
            name: "bot-fixture",
            scope: "instance",
            derived_from_public_id: "main",
            handle: "bot-fixture",
            description: "Bot",
            agent_identifier: "bot-fixture",
            steward_public_id: "owner",
            kind: "agent",
            configuration: {
              tool_definitions: [],
              kernel_tools: [],
              runner_executor_public_ids: [],
              mcp_tools: [],
              fallback_models: [],
            },
          },
        ],
      })
    if (url.pathname.endsWith("/conversations")) {
      pages.push(url.searchParams.get("after") ?? "first")
      return Response.json({
        conversations: url.searchParams.has("after")
          ? [conversationFixture({ public_id: "later", title: "Later session" })]
          : Array.from({ length: 10 }, (_, index) =>
              conversationFixture({ public_id: "early-" + index, title: "Earlier session" }),
            ),
        pagination: { next_after: url.searchParams.has("after") ? null : "next" },
      })
    }
  })
  try {
    const application = new NexusApplication(
      store.client,
      { agent: "main", runner: "runner", workspace: "workspace" },
      () => ({}),
    )
    const { telegramConversationCommand } = await import("../src/telegram-commands")
    const result = await telegramConversationCommand("sessions", "2", {
      application,
      bot,
      current: null,
      owner: true,
      key: "history",
      signal: new AbortController().signal,
    })
    expect(result).toContain("Later session")
    expect(pages).toEqual(["first", "next"])
  } finally {
    store.server.stop(true)
  }
})
