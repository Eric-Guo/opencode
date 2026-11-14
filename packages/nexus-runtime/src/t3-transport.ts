import { Schema } from "effect"
import WebSocket from "ws"
import type { JsonValue } from "@cybros/agent"

const Frame = Schema.Struct({
  _tag: Schema.String,
  requestId: Schema.optional(Schema.String),
  exit: Schema.optional(Schema.Struct({ _tag: Schema.String, value: Schema.optional(Schema.MutableJson) })),
})
const Ticket = Schema.Struct({ ticket: Schema.NonEmptyString })
const Config = Schema.Struct({ environment: Schema.Struct({ orchestrationProtocolVersion: Schema.Literal(2) }) })

export class T3Uncertain extends Error {}

/** Every exchange authenticates afresh. A lost mutation response is never retried here. */
export class T3Transport {
  constructor(
    readonly origin: string,
    private readonly token: string,
  ) {}

  async http(method: string, path: string, body: object | undefined, signal: AbortSignal) {
    if (!this.origin || !this.token) throw new Error("Configure the T3 service URL and bearer first.")
    const active = AbortSignal.any([signal, AbortSignal.timeout(30000)])
    const response = await fetch(new URL(path, this.origin), {
      method,
      headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: active,
    }).catch(() => {
      signal.throwIfAborted()
      throw new T3Uncertain("T3 response was unavailable; inspect existing work before another mutation.")
    })
    if (!response.ok) throw new Error("T3 request failed (HTTP " + response.status + ").")
    return read(response, path.endsWith("websocket-ticket") ? 65536 : 4 * 1024 * 1024).catch(() => {
      signal.throwIfAborted()
      throw new T3Uncertain("T3 returned an incomplete or oversized response; reconcile existing work.")
    })
  }

  async call(method: string, payload: object, signal: AbortSignal): Promise<JsonValue> {
    const active = AbortSignal.any([signal, AbortSignal.timeout(30000)])
    const ticket = Schema.decodeUnknownSync(Ticket)(
      await this.http(
        "POST",
        "/api/auth/websocket-ticket",
        undefined,
        AbortSignal.any([active, AbortSignal.timeout(10000)]),
      ),
    )
    const url = new URL("/ws", this.origin)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.search = new URLSearchParams({ wsTicket: ticket.ticket, orchestrationProtocol: "2" }).toString()
    active.throwIfAborted()
    const socket = new WebSocket(url, {
      handshakeTimeout: 10000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    })
    const state = { sent: false }
    let abort: (() => void) | undefined
    const timer = setTimeout(() => socket.terminate(), 20000)
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: "Ping" }))
    }, 5000)

    try {
      return await new Promise<JsonValue>((resolve, reject) => {
        const unavailable = () =>
          reject(
            state.sent
              ? new T3Uncertain("T3 RPC response was unavailable; reconcile the existing work.")
              : new Error("T3 RPC connection failed."),
          )
        abort = () => reject(active.reason)
        active.addEventListener("abort", abort, { once: true })
        socket.once("close", unavailable)
        socket.once("error", unavailable)
        const send = (id: string, tag: string, body: object) =>
          socket.send(JSON.stringify({ _tag: "Request", id, tag, payload: body, headers: [] }))
        socket.once("open", () => send("0", "server.getConfig", {}))
        socket.on("message", (data) => {
          try {
            const message = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(data.toString())
            for (const item of Array.isArray(message) ? message : [message]) {
              const frame = Schema.decodeUnknownSync(Frame)(item)
              if (frame._tag === "Ping") {
                socket.send(JSON.stringify({ _tag: "Pong" }))
                continue
              }
              if (frame._tag === "Pong") continue
              if (frame._tag !== "Exit" || frame.exit?._tag !== "Success") throw new Error("T3 refused the operation.")
              if (frame.requestId === "0") {
                Schema.decodeUnknownSync(Config)(frame.exit.value)
                if (method === "server.getConfig") {
                  resolve(frame.exit.value ?? null)
                  continue
                }
                state.sent = true
                send("1", method, payload)
              }
              if (frame.requestId === "1") resolve(frame.exit.value ?? null)
            }
          } catch {
            reject(new Error("T3 returned an invalid or incompatible protocol-2 response."))
          }
        })
        if (active.aborted) abort()
      })
    } finally {
      clearTimeout(timer)
      clearInterval(heartbeat)
      if (abort) active.removeEventListener("abort", abort)
      socket.terminate()
    }
  }
}

async function read(response: Response, limit: number) {
  if (!response.body) throw new Error("T3 returned an empty response.")
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) throw new Error("T3 response exceeded its size bound.")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(Buffer.concat(chunks).toString("utf8"))
}
