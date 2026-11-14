import { TelegramAPI, TelegramError } from "./telegram-api"
import type { StoreDocument } from "./document"
import type { TelegramConnectionState, TelegramWork } from "./telegram-state"

/** All topics and borrowed Bot sends share the physical connection's slot and budget. */
export class TelegramTransport {
  private slot = Promise.resolve()
  private bot = 0
  private readonly chats = new Map<string, number>()
  private readonly previews = new Map<string, number>()

  constructor(
    readonly api: TelegramAPI,
    private readonly document: StoreDocument<typeof TelegramConnectionState.Type>,
  ) {}

  async send<T>(
    route: TelegramWork["route"],
    now: number,
    send: (api: TelegramAPI) => Promise<T>,
    progress = false,
  ): Promise<T | undefined> {
    const previous = this.slot
    const released = Promise.withResolvers<void>()
    this.slot = released.promise
    await previous
    try {
      if (
        Math.max(
          this.bot,
          this.chats.get(route.chat) ?? 0,
          progress ? (this.previews.get(route.chat) ?? 0) : 0,
          (await this.document.read())?.retry ?? 0,
        ) > now
      )
        return
      const result = await send(this.api)
      this.bot = now + 1000 / 30
      this.chats.set(route.chat, now + (route.group ? 3000 : 1000))
      if (progress) this.previews.set(route.chat, now + (route.group ? 4000 : 1000))
      return result
    } catch (error) {
      if (error instanceof TelegramError && error.retryAfter !== undefined) await this.throttle(error.retryAfter, now)
      throw error
    } finally {
      released.resolve()
    }
  }

  async throttle(seconds: number, now: number) {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new Error("Telegram retry_after must be finite and nonnegative.")
    await this.document.change((state) => ({
      offset: 0,
      identity: null,
      ...state,
      retry: Math.max(state?.retry ?? 0, now + seconds * 1000),
    }))
  }

  async typing(route: TelegramWork["route"], now: number) {
    if (((await this.document.read())?.retry ?? 0) > now) return
    try {
      await this.api.call("sendChatAction", {
        chat_id: route.chat,
        ...(route.topic ? { message_thread_id: route.topic } : {}),
        action: "typing",
      })
    } catch (error) {
      if (error instanceof TelegramError && error.retryAfter !== undefined) await this.throttle(error.retryAfter, now)
      throw error
    }
  }
}
