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

export const T3Workspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root"), branch: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: Schema.NonEmptyString,
    branch: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.NonEmptyString,
    branch: Schema.optional(Schema.String),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
])
export const T3Selection = Schema.Struct({ instanceId: Schema.String, model: Schema.String })
const Message = { messageId: Schema.String, text: Schema.String, attachments: Schema.Array(Schema.MutableJson) }
const Command = { threadId: Schema.String, commandId: Schema.String }
const requests: Readonly<Record<string, Schema.Top>> = {
  "server.getConfig": Schema.Record(Schema.String, Schema.MutableJson),
  "orchestration.getThreadProjection": Schema.Struct({ threadId: Schema.String }),
  "orchestration.getTurnItem": Schema.Struct({ threadId: Schema.String, itemId: Schema.String }),
  "orchestration.getFullThreadDiff": Schema.Struct({
    threadId: Schema.String,
    toTurnCount: Schema.Number,
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  "orchestration.launchThread": Schema.Struct({
    ...Command,
    projectId: Schema.String,
    title: Schema.String,
    modelSelection: T3Selection,
    runtimeMode: Schema.Literal("approval-required"),
    interactionMode: Schema.Literal("default"),
    workspaceStrategy: T3Workspace,
    initialMessage: Schema.Struct(Message),
  }),
  "orchestration.dispatchCommand": Schema.Union([
    Schema.Struct({
      ...Command,
      ...Message,
      type: Schema.Literal("message.dispatch"),
      createdBy: Schema.Literal("agent"),
      creationSource: Schema.Literal("server"),
      dispatchMode: Schema.Union([
        Schema.Struct({ type: Schema.Literal("start_immediately") }),
        Schema.Struct({ type: Schema.Literal("steer_active"), targetRunId: Schema.String }),
      ]),
    }),
    Schema.Struct({
      ...Command,
      type: Schema.Literal("run.interrupt"),
      runId: Schema.String,
      holdQueue: Schema.Literal(true),
      reason: Schema.String,
    }),
    Schema.Struct({
      ...Command,
      type: Schema.Literal("runtime-request.respond"),
      requestId: Schema.String,
      decision: Schema.optional(Schema.Literals(["accept", "decline"])),
      answers: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    }),
  ]),
}

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
    signal.throwIfAborted()
    if (!Object.hasOwn(requests, method)) throw new Error("Unsupported T3 RPC method.")
    if (!Schema.is(requests[method]!)(payload)) throw new Error("Invalid T3 RPC payload.")
    const business = JSON.stringify({ _tag: "Request", id: "1", tag: method, payload, headers: [] })
    if (Buffer.byteLength(business) > 4 * 1024 * 1024) throw new Error("T3 request exceeded the 4 MiB bound.")

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
        const fail = (reason: unknown) => {
          socket.removeAllListeners("message")
          reject(reason)
        }
        const unavailable = () =>
          fail(
            state.sent
              ? new T3Uncertain("T3 RPC response was unavailable; reconcile the existing work.")
              : new Error("T3 RPC connection failed."),
          )
        abort = () => (signal.aborted ? fail(signal.reason) : unavailable())
        active.addEventListener("abort", abort, { once: true })
        socket.once("close", unavailable)
        socket.once("error", unavailable)
        const incompatible = () => fail(new Error("T3 requires orchestration protocol-2."))
        socket.once("unexpected-response", (_request, response) => {
          response.destroy()
          if (response.statusCode === 426) incompatible()
          else unavailable()
        })
        socket.once("open", () =>
          socket.send(JSON.stringify({ _tag: "Request", id: "0", tag: "server.getConfig", payload: {}, headers: [] })),
        )
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
              if (
                frame._tag !== "Exit" ||
                frame.requestId !== (state.sent ? "1" : "0") ||
                frame.exit?._tag !== "Success"
              )
                return unavailable()
              if (state.sent) return resolve(frame.exit.value ?? null)
              if (!Schema.is(Config)(frame.exit.value)) return incompatible()
              if (method === "server.getConfig") return resolve(frame.exit.value ?? null)

              state.sent = true
              // Only the next WebSocket message can answer the request we are sending now.
              return socket.send(business)
            }
          } catch {
            unavailable()
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
