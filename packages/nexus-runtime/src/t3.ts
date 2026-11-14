import { setTimeout as delay } from "node:timers/promises"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { definition, type RunnerTool } from "./extensions"

const Frame = Schema.Struct({
  _tag: Schema.String,
  requestId: Schema.optional(Schema.String),
  exit: Schema.optional(Schema.Struct({ _tag: Schema.String, value: Schema.optional(Schema.MutableJson) })),
})
const Question = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  options: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.optional(Schema.String) })),
})
const Projection = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String, projectId: Schema.String, runtimeMode: Schema.String }),
  runs: Schema.Array(Schema.Struct({ id: Schema.String, ordinal: Schema.Number, status: Schema.String })),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
  runtimeRequests: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      nodeId: Schema.String,
      status: Schema.String,
      kind: Schema.String,
      responseCapability: Schema.Struct({ type: Schema.String, providerSessionId: Schema.optional(Schema.String) }),
    }),
  ),
  nodes: Schema.Array(
    Schema.Struct({ id: Schema.String, parentNodeId: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
  turnItems: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      nodeId: Schema.optional(Schema.String),
      requestId: Schema.optional(Schema.String),
      questions: Schema.optional(Schema.Array(Question)),
      input: Schema.optional(Schema.MutableJson),
      changes: Schema.optional(Schema.MutableJson),
    }),
  ),
  providerSessions: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.String, cwd: Schema.optional(Schema.String) }),
  ),
  subagents: Schema.Array(Schema.Struct({ status: Schema.String })),
})
const Config = Schema.Struct({ environment: Schema.Struct({ orchestrationProtocolVersion: Schema.Literal(2) }) })
const Ticket = Schema.Struct({ ticket: Schema.NonEmptyString })

async function rpc(origin: URL, token: string, method: string, payload: object, signal: AbortSignal) {
  const auth = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    redirect: "error",
    signal,
  })
  if (!auth.ok) throw new Error("T3 authentication failed.")
  const ticket = Schema.decodeUnknownSync(Ticket)(await auth.json())
  const url = new URL("/ws", origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.search = new URLSearchParams({ wsTicket: ticket.ticket, orchestrationProtocol: "2" }).toString()
  signal.throwIfAborted()
  const socket = new WebSocket(url)
  try {
    return await new Promise<typeof Schema.MutableJson.Type>((resolve, reject) => {
      const abort = () => reject(new Error("T3 request cancelled."))
      signal.addEventListener("abort", abort, { once: true })
      socket.onclose = () => {
        signal.removeEventListener("abort", abort)
        reject(new Error("T3 connection closed."))
      }
      socket.onerror = () => reject(new Error("T3 connection failed."))
      const send = (id: string, tag: string, body: object) =>
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload: body, headers: [] }))
      socket.onopen = () => send("0", "server.getConfig", {})
      socket.onmessage = ({ data }) => {
        try {
          const message = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(data)
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
              send("1", method, payload)
            } else if (frame.requestId === "1") resolve(frame.exit.value ?? null)
          }
        } catch (error) {
          reject(error)
        }
      }
      if (signal.aborted) abort()
    })
  } finally {
    socket.close()
  }
}

export function t3Tools(endpoint: string, credentials?: { token: string; project: string }): RunnerTool[] {
  const origin = new URL(endpoint)
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password)
    throw new Error("Invalid T3 URL.")
  const token = credentials?.token ?? process.env.OPENCODE_NEXUS_T3_TOKEN
  const project = credentials?.project ?? process.env.OPENCODE_NEXUS_T3_PROJECT
  if (!token || !project) throw new Error("Configure the T3 token and project ID.")
  const string = { type: "string" }
  return [
    {
      definition: {
        timeout_ms: 600000,
        ...definition(
          "coding_work",
          "Start, inspect or interrupt a T3 coding assignment in the configured project. Use the original assignment key to inspect its results.",
          {
            action: { enum: ["start", "status", "wait", "stop", "diff", "followup"] },
            assignment: string,
            agent: string,
            model: string,
            prompt: string,
          },
          ["assignment", "action"],
        ),
      },
      async execute(input, ctx) {
        if (!ctx.conversation || typeof input.assignment !== "string" || !input.assignment.trim())
          throw new Error("Expected a conversation and assignment key.")
        const id = (kind: string) =>
          createHash("sha256")
            .update(JSON.stringify([ctx.workspace, ctx.conversation, input.assignment, kind]))
            .digest("hex")
            .slice(0, 32)
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
        const threadId = id("thread")
        const call = (method: string, body: object) => rpc(origin, token, method, body, ctx.signal)
        if (input.action === "start") {
          if (typeof input.prompt !== "string" || typeof input.agent !== "string" || typeof input.model !== "string")
            throw new Error("Supply a prompt, provider instance and model.")
          await call("orchestration.launchThread", {
            projectId: project,
            threadId,
            commandId: id("launch"),
            title: input.assignment,
            modelSelection: { instanceId: input.agent, model: input.model },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: id("message"), text: input.prompt, attachments: [] },
          })
        }
        const projection = async () => {
          const state = Schema.decodeUnknownSync(Projection)(
            await call("orchestration.getThreadProjection", { threadId }),
          )
          if (
            state.thread.projectId !== project ||
            state.thread.id !== threadId ||
            state.thread.runtimeMode !== "approval-required"
          )
            throw new Error("Unknown T3 assignment or changed permission mode.")
          return state
        }
        if (input.action === "followup") {
          if (typeof input.prompt !== "string") throw new Error("Supply a follow-up prompt.")
          await projection()
          await call("orchestration.dispatchCommand", {
            type: "message.dispatch",
            threadId,
            commandId: id(ctx.task + ":send"),
            messageId: id(ctx.task + ":message"),
            createdBy: "agent",
            creationSource: "server",
            text: input.prompt,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          })
        }
        const wait = ["start", "wait", "followup"].includes(String(input.action))
        const interrupt = async (runId: string, signal: AbortSignal) =>
          rpc(
            origin,
            token,
            "orchestration.dispatchCommand",
            {
              type: "run.interrupt",
              commandId: id("stop:" + runId),
              threadId,
              runId,
              holdQueue: true,
              reason: "Stopped by Nexus",
            },
            signal,
          )
        let running: string | undefined
        try {
          while (true) {
            const state = await projection()
            const latest = state.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
            const settled = latest && ["completed", "interrupted", "failed", "cancelled"].includes(latest.status)
            running = settled ? undefined : latest?.id
            if (input.action === "stop" && running) await interrupt(running, ctx.signal)
            if (input.action === "diff" && latest)
              return {
                content: JSON.stringify(
                  await call("orchestration.getFullThreadDiff", { threadId, toTurnCount: latest.ordinal }),
                ).slice(0, 65536),
              }
            if (
              !wait ||
              (settled && !state.subagents.some((worker) => ["pending", "running", "waiting"].includes(worker.status)))
            ) {
              return {
                content: JSON.stringify({
                  run: latest,
                  messages: state.messages.filter((m) => m.role === "assistant"),
                  requests: state.runtimeRequests.filter((r) => r.status === "pending"),
                }).slice(-65536),
              }
            }
            const request = state.runtimeRequests.find((r) => r.status === "pending")
            if (request && ctx.ask) {
              const item = state.turnItems.find((item) => item.requestId === request.id)
              const session = state.providerSessions.find(
                (session) =>
                  session.id === request.responseCapability.providerSessionId &&
                  ["ready", "running", "waiting"].includes(session.status),
              )
              if (!item || (!session && request.responseCapability.type !== "message"))
                throw new Error("Native question has expired.")
              const answers: Record<string, string | string[]> = {}
              let decision = "decline"
              if (request.kind === "user_input") {
                if (!item.questions?.length) throw new Error("Missing native questions.")
                for (const q of item.questions) {
                  const labels = q.options.map((option) => option.label)
                  const text = await ctx.ask(
                    "t3_" + id(request.id + q.id),
                    q.question + (q.multiSelect ? " Return a JSON array of labels: " + JSON.stringify(labels) : ""),
                    q.multiSelect ? undefined : labels,
                  )
                  const selected = q.multiSelect
                    ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(text)
                    : [text]
                  const values = selected.map((label) => {
                    const option = q.options.find((option) => option.label === label)
                    if (!option && labels.length && q.allowCustomAnswer === false)
                      throw new Error("Choose an offered answer.")
                    return option?.value ?? label
                  })
                  answers[q.id] = q.multiSelect ? values : values[0]
                }
              } else {
                const parent = state.nodes.find((node) => node.id === request.nodeId)?.parentNodeId
                const operation = parent && state.turnItems.find((item) => item.nodeId === parent && !item.requestId)
                if (
                  session?.cwd === ctx.directory &&
                  operation &&
                  ((request.kind === "command" && operation.type === "command_execution" && operation.input) ||
                    (request.kind === "file_change" && operation.type === "file_change" && operation.changes))
                ) {
                  decision = await ctx.ask(
                    "t3_" + id(request.id),
                    "T3 requests a one-time operation in " + ctx.directory + "\n" + JSON.stringify(operation),
                    ["accept", "decline"],
                  )
                }
              }
              const fresh = await projection()
              if (!fresh.runtimeRequests.some((row) => row.id === request.id && row.status === "pending")) continue
              await call("orchestration.dispatchCommand", {
                type: "runtime-request.respond",
                commandId: id(request.id),
                threadId,
                requestId: request.id,
                ...(request.kind === "user_input"
                  ? { answers }
                  : { decision: decision === "accept" ? "accept" : "decline" }),
              })
            }
            await delay(500, undefined, { signal: ctx.signal })
          }
        } finally {
          if (ctx.signal.aborted && running) await interrupt(running, AbortSignal.timeout(5000)).catch(() => {})
        }
      },
    },
  ]
}
