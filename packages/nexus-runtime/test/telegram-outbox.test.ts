import { afterEach, expect, test } from "bun:test"
import type { JsonObject, OutboxMessage } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { Channels } from "../src/channels"
import { TelegramIngress } from "../src/telegram-ingress"
import { storeFixture } from "./fixture/store"

const connection = "00000000-0000-4000-8000-000000000001"
const spare = "00000000-0000-4000-8000-000000000002"
const now = 1700000000000

function outboxMessage(fields: Partial<OutboxMessage>): OutboxMessage {
  return {
    public_id: "out-1",
    conversation_public_id: null,
    channel_key: "telegram:" + connection,
    thread_key: "42",
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
    created_at: new Date(now).toISOString(),
    ...fields,
  }
}

function fixture(
  connections: Record<string, { enabled?: boolean; token?: string }> = { [connection]: { token: "fixture-token" } },
) {
  const sent: JsonObject[] = []
  const claims: JsonObject[] = []
  const settlements: [string, JsonObject][] = []
  const state = { claimable: [] as OutboxMessage[], workspaceFailures: 0 }
  const service = storeFixture(async (request) => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path.endsWith("/getMe"))
      return Response.json({ ok: true, result: { id: 123, username: "FixtureBot", is_bot: true } })
    if (path.endsWith("/setMyCommands") || path.endsWith("/sendChatAction"))
      return Response.json({ ok: true, result: true })
    if (path.endsWith("/getUpdates")) return Response.json({ ok: true, result: [] })
    if (path.endsWith("/sendMessage")) {
      const body = (await request.json()) as JsonObject

      sent.push(body)
      if (body.text === "kicked")
        return Response.json(
          { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" },
          { status: 403 },
        )
      if (body.text === "drop") return new Response("incomplete", { status: 200 })
      if (body.text === "limited")
        return Response.json(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 3",
            parameters: { retry_after: 3 },
          },
          { status: 429 },
        )
      if (body.text === "server")
        return Response.json({ ok: false, error_code: 500, description: "Internal Server Error" }, { status: 500 })
      return Response.json({ ok: true, result: { message_id: 1000 + sent.length } })
    }
    if (path.endsWith("/workspaces")) {
      if (state.workspaceFailures > 0) {
        state.workspaceFailures--
        return Response.json({ error: { code: "unavailable" } }, { status: 503 })
      }
      return Response.json({
        workspaces: [
          {
            public_id: "workspace",
            name: "Home",
            access_mode: "private",
            state: "active",
            dedicated: false,
            lock_version: 0,
            archived_at: null,
            created_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
          },
        ],
        pagination: { next_after: null },
      })
    }
    if (path.endsWith("/outbox_messages/claim") && request.method === "POST") {
      claims.push(((await request.json()) as { claim: JsonObject }).claim)
      const rows = state.claimable

      state.claimable = []
      return Response.json({ outbox_messages: rows })
    }
    if (path.endsWith("/settlement") && request.method === "POST") {
      const id = path.split("/").at(-2)!
      const settlement = ((await request.json()) as { settlement: JsonObject }).settlement

      settlements.push([id, settlement])
      return Response.json({ outbox_message: outboxMessage({ public_id: id, status: String(settlement.action) }) })
    }
  })
  const open = () => {
    const app = new NexusApplication(
      service.client,
      { workspace: "workspace", agent: "main", runner: "runner" },
      () => ({ default_model: "provider/original" }),
    )

    return new TelegramIngress(
      { connections, bots: {} },
      { application: () => app, signal: AbortSignal.timeout(15000), origin: service.server.url.origin },
    )
  }

  return {
    ...service,
    sent,
    claims,
    settlements,
    state,
    open,
    [Symbol.dispose]() {
      service.server.stop(true)
    },
  }
}

afterEach(() => {
  for (const prefix of Channels.registeredPrefixes()) Channels.unregisterAdapter(prefix)
})

async function until(condition: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("the outbox adapter sends a topic thread reply through the connection transport", async () => {
  using peer = fixture()
  const ingress = peer.open()

  const verdict = await ingress.deliverOutbox(outboxMessage({ thread_key: "-10099:7", body: "ok" }))

  expect(verdict).toBe("sent")
  expect(peer.sent).toEqual([{ chat_id: "-10099", text: "ok", message_thread_id: 7 }])
})

test("the outbox adapter drops gone channels before or at the wire", async () => {
  using peer = fixture()
  const ingress = peer.open()

  expect(await ingress.deliverOutbox(outboxMessage({ body: "kicked" }))).toEqual(["dropped", "channel_gone"])
  expect(await ingress.deliverOutbox(outboxMessage({ thread_key: "", body: "ok" }))).toEqual(["dropped", "channel_gone"])
  expect(await ingress.deliverOutbox(outboxMessage({ thread_key: "42:not-a-topic", body: "ok" }))).toEqual([
    "dropped",
    "channel_gone",
  ])
  expect(
    await ingress.deliverOutbox(
      outboxMessage({ channel_key: "telegram:00000000-0000-4000-8000-000000000099", body: "ok" }),
    ),
  ).toEqual(["failed", "telegram_connection_unavailable"])
  expect(peer.sent).toHaveLength(1)
})

test("the outbox adapter reports ambiguous transport failures as uncertain", async () => {
  using peer = fixture()
  const ingress = peer.open()

  expect(await ingress.deliverOutbox(outboxMessage({ body: "drop" }))).toBe("uncertain")
  expect(await ingress.deliverOutbox(outboxMessage({ body: "server" }))).toBe("uncertain")
  expect(peer.sent).toHaveLength(2)
})

test("the outbox adapter fails refusals with their description and honors retry_after", async () => {
  using peer = fixture()
  const ingress = peer.open()

  expect(await ingress.deliverOutbox(outboxMessage({ body: "limited" }))).toEqual([
    "failed",
    "Too Many Requests: retry after 3",
  ])
  expect(await ingress.deliverOutbox(outboxMessage({ body: "ok" }))).toEqual(["failed", "rate_limited"])
  expect(peer.sent).toHaveLength(1)
})

test("the outbox adapter resolves empty connection ids against the single active connection", async () => {
  using single = fixture()
  const ingress = single.open()

  expect(await ingress.deliverOutbox(outboxMessage({ channel_key: "telegram", body: "ok" }))).toBe("sent")
  expect(single.sent[0]).toMatchObject({ chat_id: "42", text: "ok" })

  using multiple = fixture({ [connection]: { token: "fixture-token" }, [spare]: { token: "other-token" } })
  const ambiguous = multiple.open()

  expect(await ambiguous.deliverOutbox(outboxMessage({ channel_key: "telegram", body: "ok" }))).toEqual([
    "failed",
    "ambiguous_or_missing_telegram_connection",
  ])
  expect(multiple.sent).toHaveLength(0)

  using disabled = fixture({ [connection]: { token: "fixture-token", enabled: false } })
  const retired = disabled.open()

  expect(await retired.deliverOutbox(outboxMessage({ channel_key: "telegram", body: "ok" }))).toEqual([
    "failed",
    "ambiguous_or_missing_telegram_connection",
  ])
  expect(await retired.deliverOutbox(outboxMessage({ body: "ok" }))).toEqual([
    "failed",
    "telegram_connection_unavailable",
  ])
})

test("the outbox pump drains due messages and retires the adapter on close", async () => {
  using peer = fixture()
  peer.state.claimable = [outboxMessage({ public_id: "m1", thread_key: "-10099:7", body: "pump" })]
  const ingress = peer.open()
  const running = ingress.run()

  await until(() => peer.settlements.length === 1)

  expect(Channels.adapterFor("telegram:" + connection)).toBeDefined()
  expect(peer.claims[0]).toEqual({ channel_key: "telegram:" + connection, limit: 10, lease_seconds: 30 })
  expect(peer.sent[0]).toMatchObject({ chat_id: "-10099", text: "pump", message_thread_id: 7 })
  expect(peer.settlements[0]).toEqual(["m1", { action: "sent" }])

  await ingress.close()
  await running
  expect(Channels.adapterFor("telegram:" + connection)).toBeUndefined()

  peer.state.claimable = [outboxMessage({ public_id: "m2", body: "later" })]
  const drained = await new Channels(peer.client.profile.storeEntries).drainOutbox({
    client: peer.client,
    workspace_public_id: "workspace",
  })

  expect(drained).toEqual([{ public_id: "m2", outcome: "no_adapter" }])
})

test("the outbox pump survives a failed drain pass", async () => {
  using peer = fixture()
  peer.state.claimable = [outboxMessage({ public_id: "m1", body: "pump" })]
  peer.state.workspaceFailures = 1
  const ingress = peer.open()
  const running = ingress.run()

  // The pump waits out its 2-second production interval before retrying the failed pass.
  await until(() => peer.settlements.length === 1, 8000)

  expect(peer.settlements[0]).toEqual(["m1", { action: "sent" }])
  await ingress.close()
  await running
}, 15000)
