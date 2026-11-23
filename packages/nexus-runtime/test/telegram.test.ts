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
import { conversationFixture, inputFixture, turnFixture } from "./fixture/conversation"

const connection = "00000000-0000-4000-8000-000000000001"
const bot = "00000000-0000-4000-8000-000000000002"
const second = "00000000-0000-4000-8000-000000000003"
const now = 1700000000000

function fixture(group = true) {
  const state = {
    physical: 123,
    loseInput: false,
    rateLimited: false,
    pollRetry: undefined as number | undefined,
    updates: [] as JsonObject[],
    uncertainSend: false,
    terminal: false,
    running: false,
    fallback: false,
    held: undefined as JsonObject | undefined,
    formatting: false,
    loseSchedule: false,
    loseExecutionPage: false,
    occurrences: [] as JsonObject[],
    loseResume: false,
    changedVariant: false,
    inference: 0,
    loseCancellation: false,
    latest: 1,
    fork: "ok",
    regeneration: "ok",
    variantText: "The result belongs to the original conversation.",
    discussion: [] as JsonObject[],
    waiting: [] as JsonObject[],
  }
  const sent: JsonObject[] = []
  const previews: JsonObject[] = []
  const inputs: { key: string; body: JsonObject; conversation: string }[] = []
  const queueWrites: { id: string; method: string; body?: unknown }[] = []
  const requests: string[] = []
  const schedules: { key: string; body: JsonObject; path: string }[] = []
  const scheduleEdits: JsonObject[] = []
  const forks: { key: string | null; body: unknown }[] = []
  const historyReads: Record<string, string>[] = []
  const windows: { path: string; query: Record<string, string> }[] = []
  const cancellations: string[] = []
  const regenerations: (string | null)[] = []
  const contextEstimates: JsonObject[] = []
  const participationPrompts: JsonObject[] = []
  const regenerated = {
    public_id: "regenerated",
    source: "regenerate",
    status: "running",
    run_public_id: "candidate-run",
    content: "New answer",
  }
  const service = storeFixture(async (request) => {
    const url = new URL(request.url)
    const path = url.pathname
    requests.push(path)
    if (path.endsWith("/history") || path.endsWith("/conversation_search")) {
      windows.push({ path, query: Object.fromEntries(url.searchParams) })
      if (path.endsWith("/history")) {
        const older = url.searchParams.has("before_position")

        return Response.json({
          conversation: { public_id: "conversation", title: "Current session" },
          turns: older
            ? []
            : [
                {
                  public_id: "turn-current",
                  position: 3,
                  kind: "direct_reply",
                  role: "assistant",
                  status: "completed",
                  created_at: new Date(now).toISOString(),
                  truncated: false,
                  prompt: "Question",
                  content: "Answer",
                  steers: "A steer",
                },
              ],
          truncated: false,
          pagination: { has_older: !older, before_position: older ? null : 3, has_newer: older },
        })
      }
      const older = url.searchParams.has("after")

      return Response.json({
        matches: older
          ? []
          : [
              {
                conversation_public_id: "conversation",
                title: "This chat",
                position: 3,
                excerpt: "Visible excerpt",
                field: "content",
                inherited: false,
                truncated: false,
              },
              {
                conversation_public_id: "new-conversation",
                title: "Other topic",
                position: null,
                excerpt: "Hidden excerpt",
                field: "content",
                inherited: false,
                truncated: false,
              },
            ],
        pagination: { next_after: older ? null : "search-next" },
      })
    }
    if (path.endsWith("/cancellation") && path.includes("/inference_requests/")) {
      cancellations.push(path)
      if (state.loseCancellation) {
        state.loseCancellation = false
        return Response.json({ error: { code: "unavailable" } }, { status: 503 })
      }
      return Response.json({
        inference_request: {
          public_id: path.split("/").at(-2),
          workload: "speech_generation",
          status: "canceled",
          model: { provider_id: "provider", model_ref: "model" },
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          usage_summary: {
            request_count: 0,
            input_tokens: 0,
            cache_read_tokens: 0,
            uncached_input_tokens: 0,
            cache_creation_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
            cost_amount: "0",
            cost_complete: true,
          },
        },
      })
    }
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
    if (path.endsWith("/getUpdates")) {
      if (state.pollRetry !== undefined)
        return Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: state.pollRetry } },
          { status: 429 },
        )
      return Response.json({ ok: true, result: state.updates.splice(0) })
    }
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
    if (path.endsWith("/schedules/job/executions")) {
      const start = Number(url.searchParams.get("after"))
      const limit = Number(url.searchParams.get("limit") ?? 25)
      windows.push({ path, query: Object.fromEntries(url.searchParams) })
      if (start === 100 && state.loseExecutionPage) {
        state.loseExecutionPage = false
        return Response.json({ error: { code: "unavailable" } }, { status: 503 })
      }
      const items = state.occurrences.slice(start, start + limit)
      const end = start + items.length
      return Response.json({
        executions: items,
        pagination: {
          next_after: end < state.occurrences.length ? String(end) : null,
          last_cursor: end ? String(end) : null,
        },
      })
    }
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
    if (path.endsWith("/workspaces/workspace"))
      return Response.json({
        workspace: {
          public_id: "workspace",
          name: "Home",
          state: "active",
          dedicated: false,
          access_mode: "private",
          lock_version: 0,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          metadata: {},
          tool_provider_overrides: {},
          owner: { public_id: "human", display_name: "Human" },
          creator: { public_id: "main", display_name: "Main", kind: "agent" },
        },
      })
    if (path.endsWith("/context_estimate")) {
      contextEstimates.push(((await request.json()) as { context_estimate: JsonObject }).context_estimate)
      return Response.json({
        context_estimate: {
          input_tokens: 1,
          tokenizer_exact: true,
          message_count: 1,
          history: { selected: 1, skipped: 0 },
        },
      })
    }
    if (path.endsWith("/conversations/conversation/forks")) {
      forks.push({ key: request.headers.get("idempotency-key"), body: await request.json() })
      if (state.fork === "refuse") return Response.json({ error: { code: "conflict" } }, { status: 409 })
      if (state.fork === "lose") {
        state.fork = "ok"
        return new Response("lost body", { status: 201 })
      }
      return Response.json(
        {
          conversation: conversationFixture({ public_id: "new-conversation", answering_user_public_id: bot }),
          runner_effects: { status: "untouched", runners: [] },
        },
        { status: 201 },
      )
    }
    if (path.endsWith("/children")) return Response.json({ conversations: [], pagination: { next_after: null } })
    if (path.endsWith("/memory")) return Response.json({ memory: [] })
    if (path.endsWith("/turns")) {
      const before = url.searchParams.get("before_position")
      const position = before ? Math.min(Number(before) - 1, state.latest) : 0
      const limit = Number(url.searchParams.get("limit"))
      const current = turnFixture(position, {
        public_id: position === 1 ? "turn" : "turn-" + position,
        answering_user_public_id: bot,
        active_variant: {
          public_id: position === 1 ? "variant" : "variant-" + position,
          source: "original",
          status: "completed",
          content: "A relevant observed discussion",
          run_public_id: null,
        },
      })
      return Response.json({
        turns:
          limit === 20 && state.discussion.length
            ? before
              ? [current, ...state.discussion].slice(-limit)
              : [turnFixture(0)]
            : [current],
        pagination: { before_position: null, after_position: null },
      })
    }
    if (path.endsWith("/inference_requests") && request.method === "POST") {
      state.inference++
      participationPrompts.push((await request.json()) as JsonObject)
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
    if (path.endsWith("/agent_api/v1/conversations")) {
      historyReads.push(Object.fromEntries(url.searchParams))
      const later = url.searchParams.get("after") === "next"

      return Response.json({
        conversations: later
          ? [conversationFixture({ public_id: "new-conversation", title: "Earlier session", archived_at: "yesterday" })]
          : [conversationFixture({ title: "Current session", public_id: "conversation" })],
        pagination: { next_after: later ? null : "next" },
      })
    }
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
    if (path.endsWith("/conversations/conversation/archive")) {
      if (state.loseResume) {
        state.loseResume = false
        return new Response("lost body", { status: 200 })
      }
      return Response.json({ conversation: conversationFixture({ answering_user_public_id: bot, archived_at: "now" }) })
    }
    if (path.endsWith("/workspaces/workspace/conversations") && request.method === "POST")
      return Response.json({ conversation: conversationFixture({ answering_user_public_id: bot }) }, { status: 201 })
    if (path.endsWith("/conversations/conversation") || path.endsWith("/conversations/new-conversation"))
      return Response.json({
        conversation: conversationFixture({
          public_id: path.split("/").at(-1)!,
          answering_user_public_id: bot,
          metadata: { "opencode.bot": bot },
        }),
      })
    if (path.endsWith("/inputs") && request.method === "GET")
      return Response.json({ inputs: state.waiting, input_queue: { limit: 100, held: state.waiting.length } })
    if (/\/inputs\/[^/]+$/.test(path) && ["PATCH", "DELETE"].includes(request.method)) {
      const id = path.split("/").at(-1)!
      const row = state.waiting.find((row) => row.public_id === id)
      if (!row) return Response.json({ error: { code: "not_found" } }, { status: 404 })
      if (request.method === "DELETE") {
        queueWrites.push({ id, method: request.method })
        state.waiting = state.waiting.filter((row) => row.public_id !== id)
        return new Response(null, { status: 204 })
      }
      const body = (await request.json()) as { input: JsonObject }
      queueWrites.push({ id, method: request.method, body })
      Object.assign(row, body.input, { lock_version: Number(row.lock_version) + 1 })
      return Response.json({ input: row })
    }
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
    if (path.endsWith("/turns/turn/regeneration")) {
      regenerations.push(request.headers.get("idempotency-key"))
      if (state.regeneration === "refuse") return Response.json({ error: { code: "conflict" } }, { status: 409 })
      if (state.regeneration === "lose") {
        state.regeneration = "committed"
        return new Response("lost body", { status: 202 })
      }
      return Response.json({ turn: { public_id: "turn", status: "completed" }, variant: regenerated }, { status: 202 })
    }
    if (path.endsWith("/regeneration_receipt") && state.regeneration === "committed")
      return Response.json({ turn: { public_id: "turn", status: "completed" }, variant: regenerated })
    if (path.endsWith("/turns/turn/edit"))
      return Response.json({ variant: { public_id: "edited", source: "edit", status: "completed", content: "Edited" } })
    if (path.endsWith("/turns/turn/variants/variant/activation"))
      return Response.json({
        variant: { public_id: "variant", source: "original", status: "running", run_public_id: "run" },
      })
    if (path.endsWith("/turns/turn/variants/regenerated"))
      return Response.json({ turn: { public_id: "turn", inherited: false }, variant: regenerated })
    if (path.endsWith("/runs/candidate-run"))
      return Response.json({ run: { public_id: "candidate-run", status: "running" } })
    if (path.endsWith("/scheduled-child/turns/turn/variants"))
      return Response.json({
        turn: { public_id: "turn", inherited: false },
        variants: [{ public_id: "child-variant", source: "original", status: "running", run_public_id: "child-run" }],
      })
    if (path.endsWith("/runs/child-run")) return Response.json({ run: { public_id: "child-run", status: "running" } })
    if (path.endsWith("/turns/turn/variants"))
      return Response.json({
        turn: { public_id: "turn", inherited: false },
        variants: [
          ...(state.fallback
            ? [
                {
                  public_id: "replacement",
                  source: "fallback",
                  origin_variant_public_id: "variant",
                  status: "running",
                  run_public_id: "fallback",
                },
              ]
            : []),
          ...(state.regeneration === "committed" ? [{ ...regenerated, public_id: "unrelated" }, regenerated] : []),
          {
            public_id: "variant",
            source: "original",
            active: true,
            status: state.terminal ? "completed" : "running",
            content: state.variantText,
            run_public_id: "run",
          },
        ],
      })
    if (state.held && /\/tasks\/hold(?:\/(approve|deny|resolution))?$/.test(path))
      return Response.json({ task: state.held })
    if (state.held && /\/runs\/(run|fallback)$/.test(path))
      return Response.json({
        run: { public_id: path.split("/").at(-1), status: "needs_attention", tasks: [state.held] },
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
  const open = (bots: Record<string, (typeof config.bots)[typeof bot]> = config.bots) => {
    const app = new NexusApplication(
      service.client,
      { workspace: "workspace", agent: "main", runner: "runner" },
      () => ({ default_model: "provider/original" }),
    )
    return new TelegramIngress(
      { ...config, bots },
      {
        application: () => app,
        signal: AbortSignal.timeout(10000),
        origin: service.server.url.origin,
      },
    )
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
    queueWrites,
    store: service.state,
    requests,
    schedules,
    scheduleEdits,
    forks,
    historyReads,
    windows,
    cancellations,
    regenerations,
    contextEstimates,
    participationPrompts,
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

test("a polled update survives a missing binding and recovers with its original Bot after reassignment", async () => {
  using peer = fixture()
  const update = message(8, "/job create every 1m Recover me", { sender_boost_count: 1 })
  peer.state.updates.push(update)
  peer.state.loseSchedule = true
  await expect(peer.open().poll(connection, now)).rejects.toThrow()
  const binding = peer.config.bots[bot]
  const connectionState = () =>
    [...peer.entries.values()].find((row) => row.namespace === "opencode.telegram.connection")?.value
  expect(connectionState()).toMatchObject({ offset: 0, pending: { bot, update } })

  await expect(peer.open({ [second]: binding }).poll(connection, now)).rejects.toThrow("original Bot")
  expect(connectionState()).toMatchObject({ offset: 0, pending: { bot } })
  const moved = peer.open({ [second]: binding, [bot]: { ...binding, target: { chat_id: "-200" } } })
  await moved.poll(connection, now + 700000)
  expect(peer.schedules).toHaveLength(2)
  expect(peer.schedules[1]).toEqual(peer.schedules[0])
  expect(peer.requests.filter((path) => path.endsWith("/getUpdates"))).toHaveLength(1)
  expect(connectionState()).toMatchObject({ offset: 9, pending: null })
  expect(peer.saved().jobs?.[0]?.id).toBe("job")
})

test.each(["/job create once in 2d Report", "/remind in 2d Report"])(
  "a valid first %s opens one Bot conversation after validation",
  async (command) => {
    using peer = fixture()
    peer.entries.delete(peer.current)
    const opens = () => peer.requests.filter((path) => path.endsWith("/workspaces/workspace/conversations"))
    for (const [index, invalid] of [
      "/job create every 1m",
      "/remind in invalid Report",
      "/job create daily 25:60 UTC Report",
    ].entries())
      await peer.open().ingest(connection, message(index + 1, invalid), now)

    expect(opens()).toEqual([])
    await peer.open().ingest(connection, message(4, command), now)
    expect(opens()).toHaveLength(1)
    if (command.startsWith("/job")) {
      expect(peer.schedules[0].body.prompt).toBe("Report")
      expect(peer.saved().jobs?.[0].target.conversation).toBe("conversation")
      return
    }
    expect(peer.saved().batches[0].submission).toMatchObject({
      conversation: "conversation",
      text: "Please remind me now: Report",
      deliver_at: new Date(now + 2 * 86400000).toISOString(),
    })
  },
)

test.each([86399, 86400])("a lost Telegram schedule response recovers at age %i seconds", async (age) => {
  using peer = fixture()
  const update = message(8, "/job create every 2d Report")
  peer.state.loseSchedule = true
  await expect(peer.open().ingest(connection, update, now)).rejects.toThrow()
  await peer.open().poll(connection, now + age * 1000)
  await peer.open().ingest(connection, update, now + age * 1000)

  const connectionState = [...peer.entries.values()].find((row) => row.namespace === "opencode.telegram.connection")
  expect(connectionState?.value).toMatchObject({ offset: 9, pending: null })
  expect(peer.saved().deliveries).toHaveLength(1)
  if (age === 86400) {
    expect(peer.schedules).toHaveLength(1)
    expect(peer.saved().deliveries[0].text).toContain("/job list")
    expect(peer.saved().jobs ?? []).toBeEmpty()
    return
  }
  expect(peer.schedules).toEqual([peer.schedules[0], peer.schedules[0]])
  expect(peer.saved().jobs?.[0].id).toBe("job")
})

test("a polling flood wait survives restart and zero permits immediate polling", async () => {
  using peer = fixture()
  peer.state.pollRetry = 5
  await expect(peer.open().poll(connection, now)).rejects.toThrow("429")
  const restored = peer.open()
  await restored.poll(connection, now + 4999)
  expect(peer.requests.filter((path) => path.endsWith("/getUpdates"))).toHaveLength(1)

  peer.state.pollRetry = 0
  await expect(restored.poll(connection, now + 5000)).rejects.toThrow("429")
  peer.state.pollRetry = undefined
  await restored.poll(connection, now + 5000)
  expect(peer.requests.filter((path) => path.endsWith("/getUpdates"))).toHaveLength(3)
})

test("Telegram queue keeps the IDs it displayed through reordering and a lost durable receipt", async () => {
  using peer = fixture()
  const owner = { id: 10, first_name: "Owner" }
  const ingress = peer.open()
  const command = (id: number, text: string) => message(id, text, { from: owner })
  const earlier = "2030-11-20T00:00:00Z"
  peer.state.waiting = [
    inputFixture({
      public_id: "first",
      text: "First request",
      lock_version: 7,
      deliver_at: earlier,
      attachments: [{ public_id: "upload", filename: "notes.txt", content_type: "text/plain", byte_size: 4 }],
    }),
    inputFixture({ public_id: "background", origin: "task_result" }),
    inputFixture({ public_id: "steer", state: "steering", delivery_mode: "steer" }),
  ]

  await ingress.ingest(connection, command(1, "/status"), now)
  expect(peer.saved().deliveries[0].text).toContain("Workspace: Home")
  expect(peer.saved().deliveries[0].text).toContain("Steering updates: 1")
  expect(peer.saved().queue_selections).toBeUndefined()
  peer.store.loseResponse = true
  await ingress.ingest(connection, command(2, "/queue list"), now)
  expect(peer.saved().deliveries[1].text).toContain("1. First request")
  expect(peer.saved().deliveries[1].text).toContain("1 attachment(s)")
  expect(peer.saved().deliveries[1].text).toContain("not before " + earlier)
  expect(peer.saved().deliveries[1].text).toContain("background result, read-only")
  const selected = peer.saved().queue_selections

  peer.state.waiting.reverse()
  const restarted = peer.open()
  await restarted.ingest(connection, command(2, "/queue list"), now)
  expect(peer.saved().queue_selections).toEqual(selected)
  await restarted.ingest(connection, command(3, "/queue cancel 2"), now)
  await restarted.ingest(connection, command(4, "/queue edit 3 cannot edit"), now)
  await restarted.ingest(connection, command(5, "/queue cancel 1 extra"), now)
  await restarted.ingest(connection, command(6, "/queue edit 1"), now)
  await restarted.ingest(connection, message(7, "/queue edit 1 other requester"), now)
  expect(peer.queueWrites).toEqual([])

  await restarted.ingest(connection, command(8, "/queue edit 1 exact\n  new text"), now)
  expect(peer.queueWrites[0]).toEqual({
    id: "first",
    method: "PATCH",
    body: { input: { expected_lock_version: 7, text: "exact\n  new text" } },
  })
  await restarted.ingest(connection, command(9, "/queue reschedule 1 now"), now)
  expect(peer.queueWrites[1]).toEqual({
    id: "first",
    method: "PATCH",
    body: { input: { expected_lock_version: 8, deliver_in: "0s" } },
  })
  await restarted.ingest(connection, command(10, "/queue cancel 3"), now)
  expect(peer.queueWrites[2]).toEqual({ id: "steer", method: "DELETE" })
  expect(peer.state.waiting.map((row) => row.public_id)).toEqual(["background", "first"])
})

test("Telegram preserves queued input on invalid or refused controls and retries a fork with the frozen turn", async () => {
  using peer = fixture()
  const ingress = peer.open()
  const from = { id: 10, first_name: "Owner" }
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot queued", { from, entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  expect(peer.saved().batches).toHaveLength(1)
  const commands = ["/fork typo", "/fork 1 extra", "/regenerate typo", "/undo 0", "/variants", "/resume one two"]
  for (const [index, command] of commands.entries())
    await ingress.ingest(connection, message(index + 2, command, { from }), now)

  expect(peer.saved().batches).toHaveLength(1)
  expect(peer.requests.filter((path) => path.includes("/turns"))).toEqual([])
  expect(peer.forks).toEqual([])

  peer.state.fork = "refuse"
  await ingress.ingest(connection, message(8, "/fork", { from }), now)
  expect(peer.saved().batches).toHaveLength(1)
  expect(peer.forks[0].body).toEqual({ fork: { turn_public_id: "turn", variant_public_id: "variant" } })

  peer.state.fork = "lose"
  const update = message(9, "/fork", { from })
  await expect(ingress.ingest(connection, update, now)).rejects.toThrow()
  expect(peer.saved().control?.fork).toMatchObject({ turn: "turn", variant: "variant" })
  expect(peer.saved().batches).toHaveLength(1)
  peer.state.latest = 2
  await peer.open().ingest(connection, update, now)
  expect(peer.forks.slice(1)).toEqual([peer.forks[1], peer.forks[1]])
  expect(peer.saved().batches).toHaveLength(0)
  expect(peer.saved().control).toBeNull()
})

test("Telegram context previews use the shared Bot and each requesting speaker", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/context"), now)
  await ingress.ingest(connection, message(2, "/context", { from: { id: 30, first_name: "Other requester" } }), now)
  expect(peer.contextEstimates).toEqual(
    ["speaker-20", "speaker-30"].map((speaker) => ({
      prompt: "",
      render: true,
      answering_user_public_id: bot,
      speaker_public_id: speaker,
    })),
  )
})

test("Telegram returns an immediately usable candidate receipt and bounded previews", async () => {
  using peer = fixture()
  const from = { id: 10, first_name: "Owner" }
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(0, "@FixtureBot first", { from, entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now - 2000,
  )
  peer.state.running = true
  await ingress.tick(connection, now)
  const original = peer.saved().work[0].input

  peer.state.variantText = "x".repeat(510)
  await ingress.ingest(connection, message(1, "/variants 1", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("variant · running [active]\n" + "x".repeat(499) + "…")
  await ingress.ingest(connection, message(2, "/regenerate", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Task: regenerated")
  expect(peer.saved().work.at(-1)).toMatchObject({
    input: "regenerated",
    requester: "10",
    source: [102],
    execution: { run_public_id: "candidate-run" },
  })

  const restarted = peer.open()
  await restarted.ingest(connection, message(3, "/status regenerated", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Task regenerated")
  await restarted.ingest(connection, message(4, "/stop regenerated", { from }), now)
  await restarted.ingest(connection, message(5, "/stop " + original, { from }), now)
  expect(peer.requests.filter((path) => path.endsWith("/stop"))).toEqual([
    expect.stringContaining("/candidate-run/stop"),
    expect.stringContaining("/run/stop"),
  ])
})

test("Telegram tracks the exact regenerated candidate after a lost reply and drops a refused watch", async () => {
  using peer = fixture()
  const ingress = peer.open()
  const from = { id: 10, first_name: "Owner" }
  peer.state.regeneration = "refuse"
  await ingress.ingest(connection, message(1, "/regenerate", { from }), now)
  expect(peer.saved().candidates).toEqual([])

  peer.state.regeneration = "lose"
  const update = message(2, "/regenerate", { from })
  await expect(ingress.ingest(connection, update, now)).rejects.toThrow()
  expect(peer.saved().candidates?.[0]).toMatchObject({ turn: "turn", operation: "regenerate" })
  const restarted = peer.open()
  await restarted.ingest(connection, update, now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Task: regenerated")
  await restarted.tick(connection, now)
  expect(peer.regenerations).toHaveLength(2)
  expect(peer.saved().candidates).toEqual([])
  expect(peer.saved().work.map((work) => work.input)).toEqual(["regenerated"])
})

test("Telegram follows an edited answer without a run and receipts reselecting the active variant", async () => {
  using peer = fixture()
  const from = { id: 10, first_name: "Owner" }
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/edit 1 Edited", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).not.toContain("Task:")
  expect(peer.saved().work[0]).toMatchObject({
    input: "edited",
    execution: { variant_public_id: "edited", run_public_id: null },
  })

  await ingress.ingest(connection, message(2, "/variant 1 variant", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Task: variant")
  expect(peer.saved().work.at(-1)).toMatchObject({
    input: "variant",
    terminal: true,
    execution: { run_public_id: "run" },
  })
})

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

test("Telegram participation requires its source to fit in the recent completed message window", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/mode active", { from: { id: 10, first_name: "Owner" } }), now)
  await ingress.ingest(connection, message(2, "An observed message"), now + 1)
  await ingress.tick(connection, now + 2001)
  peer.state.terminal = true
  const row = (position: number, content: string, kind = "message") =>
    turnFixture(position, {
      kind,
      active_variant: { public_id: "discussion-" + position, source: "original", status: "completed", content },
    })
  peer.state.discussion = Array.from({ length: 4 }, (_, index) => row(index + 2, "界".repeat(2500)))
  await ingress.tick(connection, now + 7001)
  expect(peer.participationPrompts).toEqual([])

  peer.state.discussion = [
    row(2, "Latest discussion in the chat"),
    row(3, "This direct reply is excluded", "direct_reply"),
  ]
  await ingress.tick(connection, now + 7002)
  expect(peer.participationPrompts).toHaveLength(1)
  const prompt = JSON.stringify(peer.participationPrompts[0])
  expect(prompt).toContain("A relevant observed discussion")
  expect(prompt).toContain("Latest discussion in the chat")
  expect(prompt).not.toContain("This direct reply is excluded")
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

test("Telegram resumes occurrence polling after a lost page and keeps pending occurrences until settled", async () => {
  using peer = fixture()
  await peer.open().ingest(connection, message(1, "/job create every 1m Report"), now)
  peer.state.occurrences = Array.from({ length: 101 }, (_, i) => ({
    child_conversation_public_id: "scheduled-child",
    input_public_id: "input-" + i,
    turn_public_id: null,
    variant_public_id: null,
    run_public_id: null,
    status: i === 100 ? "queued" : "canceled",
    scheduled_for: new Date(now).toISOString(),
    created_at: new Date(now).toISOString(),
  }))
  peer.state.loseExecutionPage = true
  await expect(peer.open().tick(connection, now + 1000)).rejects.toThrow()
  expect(peer.saved().jobs?.[0].execution_after).toBe("100")
  expect(peer.saved().work).toHaveLength(100)
  expect(peer.saved().work[0].terminal).toBe(true)
  const restarted = peer.open()
  await restarted.ingest(connection, message(2, "/status input-0"), now + 1100)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Scheduled job: job\nInput: canceled")
  await restarted.ingest(connection, message(3, "/stop input-0"), now + 1200)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("already canceled")
  await peer.open().tick(connection, now + 2000)
  expect(peer.saved().work).toHaveLength(101)
  expect(peer.saved().jobs?.[0].execution_after).toBe("100")
  Object.assign(peer.state.occurrences[100], {
    status: "running",
    turn_public_id: "turn",
    variant_public_id: "child-variant",
    run_public_id: "child-run",
  })
  await peer.open().tick(connection, now + 3000)
  expect(peer.saved().jobs?.[0].execution_after).toBe("101")
  expect(peer.saved().work.at(-1)).toMatchObject({ input: "input-100", execution: { run_public_id: "child-run" } })
  expect(
    peer.windows.filter((row) => row.path.endsWith("/executions")).map((row) => row.query.after ?? "first"),
  ).toEqual(["first", "100", "100", "100"])
})

test("Telegram history binds task controls to the occurrence before the next poll and leaves Stop on main work", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(
    connection,
    message(1, "@FixtureBot work", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    now,
  )
  await ingress.tick(connection, now + 2000)
  await ingress.ingest(connection, message(2, "/job create every 1m Report"), now + 3000)
  peer.state.running = true
  peer.state.occurrences = Array.from({ length: 26 }, (_, i) => ({
    child_conversation_public_id: "scheduled-child",
    input_public_id: "task-" + i,
    turn_public_id: "turn",
    variant_public_id: "child-variant",
    run_public_id: "child-run",
    status: "running",
    scheduled_for: new Date(now).toISOString(),
    created_at: new Date(now).toISOString(),
  }))
  await ingress.ingest(connection, message(3, "/job history job"), now + 4000)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("More: /job history job 25")
  await ingress.ingest(connection, message(4, "/job history job 25"), now + 5000)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Task: task-25 · running · " + new Date(now).toISOString())
  expect(peer.saved().jobs?.[0].execution_after).toBeUndefined()
  const next = peer.open()
  await next.ingest(connection, message(5, "/stop task-25", { from: { id: 30, is_bot: false } }), now + 6000)
  expect(peer.requests.some((path) => path.endsWith("/stop"))).toBe(false)
  await next.ingest(connection, message(6, "/steer task-25 include totals"), now + 7000)
  expect(peer.inputs.at(-1)).toMatchObject({
    conversation: "scheduled-child",
    body: { expected_steering_run_public_id: "child-run" },
  })
  await next.ingest(connection, message(7, "/stop task-25"), now + 8000)
  await next.ingest(connection, message(8, "/stop"), now + 9000)
  expect(peer.requests.filter((path) => path.endsWith("/stop"))).toEqual([
    expect.stringContaining("/child-run/stop"),
    expect.stringContaining("/run/stop"),
  ])
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

test("Telegram lists one page per command and resumes the original workspace after restart", async () => {
  using peer = fixture()
  const ingress = peer.open()
  const from = { id: 10, first_name: "Owner" }
  await ingress.ingest(connection, message(1, "/sessions 2", { from }), now)
  expect(peer.historyReads).toEqual([])
  await ingress.ingest(connection, message(2, "/sessions", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Current session [current]")
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Next page: /sessions 2")

  await peer.open().ingest(connection, message(3, "/sessions 2", { from }), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Earlier session [archived]")
  expect(peer.historyReads).toEqual([
    {
      limit: "10",
      order: "desc",
      order_by: "last_activity_at",
      metadata_key: "opencode.bot",
      metadata_value: bot,
      answering_user_public_id: bot,
    },
    {
      limit: "10",
      order: "desc",
      order_by: "last_activity_at",
      metadata_key: "opencode.bot",
      metadata_value: bot,
      answering_user_public_id: bot,
      after: "next",
    },
  ])

  await peer.open().ingest(connection, message(4, "/resume new-conversation"), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Only the Bot owner")

  peer.state.loseResume = true
  const resume = message(5, "/resume new-conversation", { from })
  await expect(peer.open().ingest(connection, resume, now)).rejects.toThrow()
  expect(peer.saved().control?.resume).toEqual({
    target: { workspace: "workspace", conversation: "new-conversation" },
  })
  const original = Schema.decodeUnknownSync(Schema.Struct({ pending: Schema.Struct({ key: Schema.String }) }))(
    peer.entries.get(peer.current)?.value,
  ).pending.key

  await peer.open().ingest(connection, resume, now)
  expect(peer.historyReads).toHaveLength(2)
  expect(peer.entries.get(peer.current)?.value).toMatchObject({
    current: { public_id: "new-conversation", workspace_public_id: "workspace" },
    receipts: { [original]: { action: "bot.resume" } },
  })
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Resumed conversation new-conversation")
})

test("Telegram renders history continuations and searches only the tracked topic after restart", async () => {
  using peer = fixture()
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "/search launch"), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("No conversations are saved")
  const initial = message(2, "@FixtureBot launch", { entities: [{ type: "mention", offset: 0, length: 11 }] })

  await ingress.ingest(connection, initial, now)
  await ingress.ingest(connection, message(3, "/sessions"), now)
  await ingress.ingest(connection, message(4, "/sessions 2"), now)
  await ingress.ingest(connection, message(5, "/history"), now)
  expect(peer.saved().deliveries.at(-1)?.text).toBe(
    "Turn 3 · turn-current\nQuestion\nAnswer\nA steer\n\nOlder history: /history before 3",
  )
  await ingress.ingest(connection, message(6, "/history before 3"), now)
  expect(peer.saved().deliveries.at(-1)?.text).toBe("No visible history in this window.")
  await ingress.ingest(connection, message(7, "/search launch"), now)
  expect(peer.saved().deliveries.at(-1)?.text).toContain("Visible excerpt")
  expect(peer.saved().deliveries.at(-1)?.text).not.toContain("Hidden excerpt")
  expect(peer.saved().deliveries.at(-1)?.text).toContain("/search next")
  await peer.open().ingest(connection, message(8, "/search next"), now)
  expect(peer.windows.map((row) => row.query)).toEqual([
    { limit: "10" },
    { limit: "10", before_position: "3" },
    { query: "launch", archived: "include", answering_user_public_id: bot, limit: "50" },
    { query: "launch", archived: "include", answering_user_public_id: bot, limit: "50", after: "search-next" },
  ])
  expect(peer.windows.every((row) => row.path.includes("/workspaces/workspace/"))).toBe(true)
})

test("Telegram resume retires only pending media for its route and retries cancellation after restart", async () => {
  using peer = fixture()
  const ingress = peer.open()
  const from = { id: 10, first_name: "Owner" }
  await ingress.ingest(connection, message(1, "/sessions", { from }), now)
  await ingress.ingest(connection, message(2, "/sessions 2", { from }), now)
  const entry = [...peer.entries.values()].find((row) => row.namespace === "opencode.telegram.bot")!
  const state = peer.saved()
  const route = state.deliveries[0].route
  const target = { workspace: "original-workspace", conversation: "conversation" }
  const delivery = { route, target, text: "Original result", retry: now + 10000 }
  const other = { ...route, topic: 9 }
  const batch = {
    route,
    target,
    requester: "10",
    speaker: "speaker",
    sources: [{ update: 0, message: 100, text: "Original source", date: now / 1000 }],
    ready: now + 10000,
    observe: false,
  }

  peer.entries.set(entry.public_id, {
    ...entry,
    value: Schema.decodeUnknownSync(Schema.MutableJson)({
      ...state,
      deliveries: [
        { ...delivery, id: "preparing", kind: "voice", status: "preparing", inference: "speech-request" },
        { ...delivery, id: "pending", kind: "voice", status: "pending" },
        { ...delivery, id: "other", kind: "voice", status: "preparing", route: other },
        { ...delivery, id: "answer", kind: "answer", status: "pending" },
        { ...delivery, id: "uncertain", kind: "voice", status: "uncertain" },
      ],
      batches: [
        {
          ...batch,
          id: "voice",
          media: { kind: "voice", file_id: "voice-file", filename: "voice.ogg", content_type: "audio/ogg" },
          inference: "transcription-request",
        },
        { ...batch, id: "other-topic", route: other },
        {
          ...batch,
          id: "submitted",
          submission: { action: "bot.submit", id: bot, ...target, key: "submitted", text: "Original source" },
        },
      ],
    }),
  })
  await peer.open().ingest(connection, message(3, "/resume new-conversation", { from }), now)
  expect(peer.saved().batches.map((row) => row.id)).toEqual(["other-topic", "submitted"])
  expect(
    peer
      .saved()
      .deliveries.map((row) => row.id)
      .slice(0, 3),
  ).toEqual(["other", "answer", "uncertain"])
  expect(peer.saved().media_cancellations?.map((row) => row.inference)).toEqual([
    "transcription-request",
    "speech-request",
  ])
  peer.state.loseCancellation = true
  await expect(peer.open().tick(connection, now)).rejects.toThrow()
  expect(peer.saved().media_cancellations).toHaveLength(2)
  await peer.open().tick(connection, now)
  expect(peer.saved().media_cancellations).toEqual([])
  const lane = "/workspaces/original-workspace/inference_requests/"

  expect(peer.cancellations.map((path) => path.slice(path.indexOf(lane)))).toEqual([
    lane + "transcription-request/cancellation",
    lane + "transcription-request/cancellation",
    lane + "speech-request/cancellation",
  ])
})

test("Telegram decisions bind the complete request to the original run across restart and fallback", async () => {
  using peer = fixture(false)
  const owner = { from: { id: 10, first_name: "Owner" }, chat: { id: 10, type: "private" } }
  const task = {
    key: "hold",
    kind: "tool_task",
    status: "needs_approval",
    lifetime: "run",
    wake: "foreground",
    waiting_on: [],
    after: [],
    tool_name: "web_fetch",
    tool_alias: "work_fetch",
    target: {
      kind: "mcp",
      connection_public_id: "work",
      display_name: "Docs",
      account_label: "Research",
      tool_name: "web_fetch",
    },
    tool_input: { url: "public" },
  }
  peer.state.running = true
  peer.state.held = task
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "Read this", owner), now)
  await ingress.tick(connection, now + 2000)
  await ingress.tick(connection, now + 5000)
  const old = peer.saved().deliveries.find((row) => row.kind === "approval")!
  expect(old).toMatchObject({ run: "run", status: "sent" })
  expect(old.text).toContain("Docs (work)\nAccount: Research\nRemote tool: web_fetch")
  const callback = (id: number, receipt: string) => ({
    update_id: id,
    callback_query: {
      id: String(id),
      from: owner.from,
      data: "approve:" + receipt,
      message: { message_id: old.message, chat: owner.chat },
    },
  })
  peer.state.fallback = true
  peer.state.held = {
    ...task,
    tool_alias: "private_fetch",
    target: { ...task.target, connection_public_id: "private", display_name: null, account_label: null },
  }
  const restored = peer.open()
  await restored.ingest(connection, callback(2, old.id), now + 6000)
  await restored.tick(connection, now + 9000)
  await restored.ingest(connection, callback(3, old.id), now + 10000)
  const replacement = peer.saved().deliveries.find((row) => row.kind === "approval")!
  expect(replacement.id).not.toBe(old.id)
  expect(replacement.text).toContain("Approve private_fetch?\nMCP connection: private\nRemote tool: web_fetch")
  expect(peer.requests.filter((p) => p.endsWith("/approve"))).toEqual([])
  await restored.tick(connection, now + 13000)
  await restored.ingest(connection, callback(4, replacement.id), now + 14000)
  expect(peer.requests.filter((p) => p.endsWith("/approve"))).toEqual([
    "/agent_api/v1/workspaces/workspace/runs/fallback/tasks/hold/approve",
  ])
})

test("Telegram offers only complete decisions up to 2000 Unicode characters", async () => {
  using peer = fixture(false)
  const owner = { from: { id: 10, first_name: "Owner" }, chat: { id: 10, type: "private" } }
  const task = {
    key: "hold",
    kind: "tool_task",
    status: "needs_approval",
    lifetime: "run",
    wake: "foreground",
    waiting_on: [],
    after: [],
    tool_name: "write",
  }
  const size = ("Approve write?\n" + JSON.stringify({ path: "" }, null, 2)).length
  const path = "😀".repeat(2000 - size)
  peer.state.running = true
  peer.state.held = { ...task, tool_input: { path } }
  const ingress = peer.open()
  await ingress.ingest(connection, message(1, "Do the work", owner), now)
  await ingress.tick(connection, now + 2000)
  await ingress.tick(connection, now + 5000)
  const old = peer.saved().deliveries.find((row) => row.kind === "approval")!
  expect(old.text).toContain(path)
  peer.state.held = { ...task, tool_input: { path: path + "x" } }
  const restored = peer.open()
  await restored.ingest(connection, message(2, "/approve", owner), now + 6000)
  await restored.ingest(
    connection,
    {
      update_id: 3,
      callback_query: {
        id: "3",
        from: owner.from,
        data: "approve:" + old.id,
        message: { message_id: old.message, chat: owner.chat },
      },
    },
    now + 7000,
  )
  await restored.tick(connection, now + 9000)
  expect(peer.saved().deliveries.find((row) => row.kind === "local")?.text).toContain("too large")
  expect(peer.requests.some((p) => p.endsWith("/approve"))).toBe(false)
  peer.state.held = {
    ...task,
    status: "awaiting_input",
    prompt: "Options?",
    fields: [{ name: "choice", type: "string" }],
  }
  await restored.tick(connection, now + 13000)
  expect(peer.saved().deliveries.find((row) => row.kind === "local")?.text).toContain("structured request")
  await restored.ingest(connection, message(4, "/answer yes", owner), now + 14000)
  expect(peer.requests.some((p) => p.endsWith("/resolution"))).toBe(false)
})
