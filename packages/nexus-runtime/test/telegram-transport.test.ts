import { expect, test } from "bun:test"
import { Schema } from "effect"
import { StoreDocument } from "../src/document"
import { TelegramAPI, TelegramError } from "../src/telegram-api"
import { TelegramConnectionState } from "../src/telegram-state"
import { TelegramTransport } from "../src/telegram-transport"
import { storeFixture } from "./fixture/store"

test("Telegram physical transport shares topic budgets and persists global 429 backoff across restart", async () => {
  const sent: string[] = []
  const state = { refuse: false }
  const service = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/bottoken/")) return
    sent.push(path.split("/").at(-1)!)
    if (state.refuse) {
      state.refuse = false
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 })
    }
    return Response.json({ ok: true, result: { message_id: sent.length } })
  })
  const open = () =>
    new TelegramTransport(
      new TelegramAPI("token", AbortSignal.timeout(2000), service.server.url.origin),
      new StoreDocument(
        service.client.profile.storeEntries,
        "opencode.telegram.connection",
        "connection",
        Schema.decodeUnknownSync(TelegramConnectionState),
      ),
    )
  const route = { connection: "connection", chat: "-100", group: true, topic: 1 }
  const now = 1700000000000
  try {
    const transport = open()
    const send = (api: TelegramAPI) => api.call("sendMessage", { chat_id: route.chat, text: "A result" })
    const borrowed = await Promise.all([
      transport.send(route, now, send),
      transport.send({ ...route, topic: 2 }, now, send),
    ])
    expect(borrowed.filter(Boolean)).toHaveLength(1)
    expect(await transport.send({ ...route, chat: "-200" }, now, send)).toBeUndefined()
    expect(await transport.send({ ...route, chat: "-200" }, now + 34, send)).toMatchObject({ message_id: 2 })
    expect(await transport.send(route, now + 2999, send)).toBeUndefined()
    await transport.typing(route, now + 2999)
    state.refuse = true
    await expect(transport.send(route, now + 3000, send)).rejects.toBeInstanceOf(TelegramError)
    const restored = open()
    expect(await restored.send({ ...route, chat: "10", group: false }, now + 7999, send)).toBeUndefined()
    await restored.typing(route, now + 7999)
    expect(sent).toEqual(["sendMessage", "sendMessage", "sendChatAction", "sendMessage"])
    expect(await restored.send(route, now + 8000, send)).toMatchObject({ message_id: 5 })
  } finally {
    service.server.stop(true)
  }
})
