import { Schema } from "effect"

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.MutableJson),
  error_code: Schema.optional(Schema.Int),
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Number) })),
})
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter?: number,
    readonly notModified = false,
  ) {
    super("Telegram request failed (" + code + ").")
  }
}
export class TelegramUncertain extends Error {}
export class TelegramRefusal extends Error {}

export class TelegramAPI {
  constructor(
    private readonly token: string,
    private readonly signal: AbortSignal,
    private readonly origin = "https://api.telegram.org",
  ) {}

  async call(method: string, body: object | FormData) {
    const response = await fetch(this.origin + "/bot" + this.token + "/" + method, {
      method: "POST",
      ...(body instanceof FormData
        ? { body }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]),
      redirect: "error",
    }).catch(() => {
      this.signal.throwIfAborted()
      throw new TelegramUncertain("Telegram did not confirm the request.")
    })
    const raw = await telegramBytes(response, 4 * 1024 * 1024).catch(() => {
      throw new TelegramUncertain("Telegram did not confirm the response body.")
    })
    const envelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))(Buffer.from(raw).toString("utf8"))
    if (envelope._tag === "None") throw new TelegramUncertain("Telegram returned an invalid response.")
    if (!response.ok || !envelope.value.ok)
      throw new TelegramError(
        envelope.value.error_code ?? response.status,
        envelope.value.parameters?.retry_after,
        /not modified/i.test(envelope.value.description ?? ""),
      )
    return envelope.value.result ?? null
  }

  async download(path: string, limit = 20 * 1024 * 1024) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes(".."))
      throw new TelegramRefusal("Invalid Telegram download path.")
    const response = await fetch(this.origin + "/file/bot" + this.token + "/" + path, {
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]),
      redirect: "error",
    })
    if (!response.ok) throw new TelegramError(response.status)
    return telegramBytes(response, limit)
  }
}

export async function telegramBytes(response: Response, limit: number) {
  if (!response.body) throw new Error("Telegram returned an empty body.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return new Uint8Array(Buffer.concat(chunks))
      count += chunk.value.length
      if (count > limit)
        throw new TelegramRefusal("Telegram transfer exceeds " + Math.floor(limit / 1024 / 1024) + " MiB.")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
}

/** Telegram limits text by UTF-16 units; never split a surrogate pair. */
export function telegramChunks(text: string, limit = 4096) {
  const chunks: string[] = []
  let current = ""
  for (const point of text) {
    if (current.length + point.length > limit) {
      chunks.push(current)
      current = ""
    }
    current += point
  }
  if (current) chunks.push(current)
  return chunks
}
