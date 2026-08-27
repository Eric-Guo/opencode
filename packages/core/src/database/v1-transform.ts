import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import type { SessionMessage } from "../session/message.js"
import type { SessionTable } from "../session/sql.js"

export type SourceMessage = {
  readonly id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

export type SourcePart = {
  readonly id: string
  readonly message_id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

export type TransformInput = {
  readonly session: Pick<typeof SessionTable.$inferSelect, "id" | "agent" | "model">
  readonly messages: ReadonlyArray<SourceMessage>
  readonly parts: ReadonlyArray<SourcePart>
}

export type Warning = {
  readonly reason: string
  readonly sessionID: string
  readonly messageID?: string
  readonly partID?: string
  readonly observedType?: string
}

export type TransformResult = {
  readonly messages: ReadonlyArray<{
    readonly id: string
    readonly session_id: string
    readonly type: SessionMessage.Type
    readonly seq: number
    readonly time_created: number
    readonly time_updated: number
    readonly data: Record<string, unknown>
  }>
  readonly session: Pick<
    typeof SessionTable.$inferInsert,
    | "agent"
    | "model"
    | "cost"
    | "tokens_input"
    | "tokens_output"
    | "tokens_reasoning"
    | "tokens_cache_read"
    | "tokens_cache_write"
    | "revert"
    | "time_compacting"
  >
  readonly watermark: number
  readonly warnings: ReadonlyArray<Warning>
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeMessage = Schema.decodeUnknownOption(SessionV1.Info)
const decodePart = Schema.decodeUnknownOption(SessionV1.Part)

export function transformSession(input: TransformInput): TransformResult {
  const warnings: Warning[] = []
  const source = input.messages.map((row) => ({ row, value: Option.getOrUndefined(decodeJson(row.data)) }))
  const messages = source
    .map((item) => {
      const value = normalizeLegacyMessage(item, source, input.session)
      const decoded =
        value && typeof value === "object"
          ? Option.getOrUndefined(decodeMessage({ ...value, id: item.row.id, sessionID: item.row.session_id }))
          : undefined
      if (decoded) return { row: item.row, value: decoded }
      warnings.push({ reason: "invalid-message", sessionID: input.session.id, messageID: item.row.id })
      return undefined
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => a.row.time_created - b.row.time_created || a.row.id.localeCompare(b.row.id))
  const messageIDs = new Set(input.messages.map((row) => row.id))
  const parts = input.parts
    .map((row) => {
      const value = Option.getOrUndefined(decodeJson(row.data))
      const observedType = value && typeof value === "object" && "type" in value ? String(value.type) : undefined
      if (!messageIDs.has(row.message_id)) {
        warnings.push({
          reason: "orphan-part",
          sessionID: input.session.id,
          messageID: row.message_id,
          partID: row.id,
          observedType,
        })
        return undefined
      }
      const decoded =
        value && typeof value === "object"
          ? Option.getOrUndefined(
              decodePart({ ...value, id: row.id, messageID: row.message_id, sessionID: row.session_id }),
            )
          : undefined
      if (decoded) return { row, value: decoded }
      warnings.push({
        reason: "invalid-part",
        sessionID: input.session.id,
        messageID: row.message_id,
        partID: row.id,
        observedType,
      })
      return undefined
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => a.row.id.localeCompare(b.row.id))
  const byMessage = Map.groupBy(parts, (item) => item.row.message_id)
  const paired = new Set<string>()
  const used = new Set(messages.map((item) => item.row.id))
  const projected = messages
    .flatMap((item) => {
      if (paired.has(item.row.id)) return []
      const owned = byMessage.get(item.row.id)?.map((part) => part.value) ?? []
      if (item.value.role === "user") {
        const compaction = owned.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
        if (compaction) {
          const pairedSummary = messages.find(
            (candidate): candidate is (typeof messages)[number] & { value: SessionV1.Assistant } =>
              candidate.value.role === "assistant" &&
              candidate.value.parentID === item.row.id &&
              candidate.value.summary === true,
          )
          if (!pairedSummary) return []
          paired.add(pairedSummary.row.id)
          if (pairedSummary.value.error || pairedSummary.value.time.completed === undefined) return []
          const summary = pairedSummary
          const summaryText = (byMessage.get(summary.row.id) ?? [])
            .map((part) => part.value)
            .filter((part): part is SessionV1.TextPart => part.type === "text" && part.text.length > 0)
            .map((part) => part.text)
            .join("\n\n")
          const tailIndex = compaction.tail_start_id
            ? messages.findIndex((candidate) => candidate.row.id === compaction.tail_start_id)
            : -1
          const compactionIndex = messages.findIndex((candidate) => candidate.row.id === item.row.id)
          const tail = tailIndex < 0 ? [] : messages.slice(tailIndex, compactionIndex)
          return [
            row(
              { ...item.row, time_updated: Math.max(item.row.time_updated, summary.row.time_updated) },
              {
                id: item.row.id,
                type: "compaction",
                status: "completed",
                reason: compaction.auto ? "auto" : "manual",
                summary: summaryText,
                recent: serializeRecent(tail, byMessage),
                time: { created: item.row.time_created },
              },
            ),
          ]
        }
        const subtasks = owned.filter((part) => part.type === "subtask")
        const visible = owned.filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
        const files = owned.filter((part): part is SessionV1.FilePart => part.type === "file")
        const agents = owned.filter((part): part is SessionV1.AgentPart => part.type === "agent")
        if (subtasks.length > 0 && visible.length === 0 && files.length === 0 && agents.length === 0) return []
        const ordinary = visible.filter((part) => !part.synthetic)
        const synthetic = visible.filter((part) => part.synthetic)
        const attachments = files.flatMap((part) => migrateFile(part))
        const unavailable = files.flatMap((part) => (!part.url.startsWith("data:") ? [unavailableFile(part)] : []))
        const text = owned
          .flatMap((part) => {
            if (part.type === "text" && !part.ignored && !part.synthetic) return [part.text]
            if (part.type === "file" && !part.url.startsWith("data:")) return [unavailableFile(part)]
            return []
          })
          .join("\n\n")
        const agentAttachments = agents.map((part) => ({
          name: part.name,
          ...(part.source
            ? { mention: { text: part.source.value, start: part.source.start, end: part.source.end } }
            : {}),
        }))
        if (
          ordinary.length === 0 &&
          unavailable.length === 0 &&
          synthetic.length > 0 &&
          attachments.length === 0 &&
          agentAttachments.length === 0
        )
          return [
            row(item.row, {
              id: item.row.id,
              type: "synthetic",
              text: synthetic.map((part) => part.text).join("\n\n"),
              time: { created: item.row.time_created },
            }),
          ]
        const user = row(item.row, {
          id: item.row.id,
          type: "user",
          text,
          ...(attachments.length ? { files: attachments } : {}),
          ...(agentAttachments.length ? { agents: agentAttachments } : {}),
          time: { created: item.row.time_created },
        })
        if (synthetic.length === 0) return [user]
        return [
          user,
          row(item.row, {
            id: syntheticID(item.row.id, used),
            type: "synthetic",
            text: synthetic.map((part) => part.text).join("\n\n"),
            time: { created: item.row.time_created },
          }),
        ]
      }
      if (item.value.role !== "assistant") return []
      const assistant = item.value
      const parent = messages.find((candidate) => candidate.row.id === assistant.parentID)
      const parentParts = parent ? (byMessage.get(parent.row.id)?.map((part) => part.value) ?? []) : []
      if (
        parentParts.some((part) => part.type === "subtask") &&
        owned.some((part) => part.type === "tool" && part.tool === "task")
      )
        return []
      const content = owned.flatMap((part): Array<Record<string, unknown>> => {
        if (part.type === "text")
          return [{ type: "text", text: part.text, ...(part.metadata ? { state: part.metadata } : {}) }]
        if (part.type === "reasoning")
          return [
            {
              type: "reasoning",
              text: part.text,
              ...(part.metadata ? { state: part.metadata } : {}),
              time: { created: part.time.start, ...(part.time.end === undefined ? {} : { completed: part.time.end }) },
            },
          ]
        if (part.type !== "tool") return []
        return [migrateTool(part, item.row.time_created)]
      })
      const start =
        owned.flatMap((part) => (part.type === "step-start" && part.snapshot ? [part.snapshot] : []))[0] ??
        owned.flatMap((part) => (part.type === "snapshot" ? [part.snapshot] : []))[0] ??
        owned.flatMap((part) => (part.type === "patch" ? [part.hash] : []))[0]
      const end = owned.flatMap((part) => (part.type === "step-finish" && part.snapshot ? [part.snapshot] : [])).at(-1)
      const snapshotFiles = Array.from(new Set(owned.flatMap((part) => (part.type === "patch" ? part.files : []))))
      const finish = normalizeFinish(assistant.finish)
      return [
        row(item.row, {
          id: item.row.id,
          type: "assistant",
          agent: assistant.agent,
          model: {
            providerID: assistant.providerID,
            id: assistant.modelID,
            variant: assistant.variant ?? "default",
          },
          content,
          ...(start || end || snapshotFiles.length
            ? {
                snapshot: {
                  ...(start ? { start } : {}),
                  ...(end ? { end } : {}),
                  ...(snapshotFiles.length ? { files: snapshotFiles } : {}),
                },
              }
            : {}),
          ...(finish ? { finish } : {}),
          cost: assistant.cost,
          tokens: {
            input: assistant.tokens.input,
            output: assistant.tokens.output,
            reasoning: assistant.tokens.reasoning,
            cache: assistant.tokens.cache,
          },
          ...(assistant.error ? { error: migrateError(assistant.error) } : {}),
          time: {
            created: item.row.time_created,
            ...(assistant.time.completed === undefined ? {} : { completed: item.row.time_updated }),
          },
        }),
      ]
    })
    .map((item, seq) => ({ ...item, seq }))
  const assistants = messages
    .map((item) => item.value)
    .filter((item): item is SessionV1.Assistant => item.role === "assistant")
  const latestUser = messages.findLast((item) => {
    if (item.value.role !== "user") return false
    const owned = byMessage.get(item.row.id) ?? []
    if (owned.some((part) => part.value.type === "compaction")) return false
    return !owned.some((part) => part.value.type === "subtask") || !owned.every((part) => part.value.type === "subtask")
  })
  return {
    messages: projected,
    session: {
      agent: input.session.agent ?? (latestUser?.value.role === "user" ? latestUser.value.agent : null),
      model:
        input.session.model ??
        (latestUser?.value.role === "user"
          ? {
              id: latestUser.value.model.modelID,
              providerID: latestUser.value.model.providerID,
              variant: latestUser.value.model.variant ?? "default",
            }
          : null),
      cost: assistants.reduce((total, item) => total + item.cost, 0),
      tokens_input: assistants.reduce((total, item) => total + item.tokens.input, 0),
      tokens_output: assistants.reduce((total, item) => total + item.tokens.output, 0),
      tokens_reasoning: assistants.reduce((total, item) => total + item.tokens.reasoning, 0),
      tokens_cache_read: assistants.reduce((total, item) => total + item.tokens.cache.read, 0),
      tokens_cache_write: assistants.reduce((total, item) => total + item.tokens.cache.write, 0),
      revert: null,
      time_compacting: null,
    },
    watermark: projected.length - 1,
    warnings,
  }
}

function normalizeLegacyMessage(
  item: { row: SourceMessage; value: unknown },
  messages: ReadonlyArray<{ row: SourceMessage; value: unknown }>,
  session: TransformInput["session"],
) {
  if (!record(item.value)) return item.value
  if (item.value.role === "assistant") {
    if (typeof item.value.agent === "string") return item.value
    return { ...item.value, agent: typeof item.value.mode === "string" ? item.value.mode : "build" }
  }
  if (item.value.role !== "user") return item.value
  if (typeof item.value.agent === "string" && record(item.value.model)) return item.value

  const child = messages
    .map((message) => message.value)
    .find(
      (message): message is Record<string, unknown> =>
        record(message) && message.role === "assistant" && message.parentID === item.row.id,
    )
  const agent =
    typeof item.value.agent === "string"
      ? item.value.agent
      : child && typeof child.agent === "string"
        ? child.agent
        : child && typeof child.mode === "string"
          ? child.mode
          : (session.agent ?? "build")
  const model =
    record(item.value.model)
      ? item.value.model
      : child && typeof child.providerID === "string" && typeof child.modelID === "string"
        ? {
            providerID: child.providerID,
            modelID: child.modelID,
            ...(typeof child.variant === "string" ? { variant: child.variant } : {}),
          }
        : {
            providerID: session.model?.providerID ?? "",
            modelID: session.model?.id ?? "",
            ...(session.model?.variant ? { variant: session.model.variant } : {}),
          }
  return { ...item.value, agent, model }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function row(
  source: SourceMessage,
  message: {
    readonly id: string
    readonly type: SessionMessage.Type
    readonly time: { readonly created: number }
    readonly [key: string]: unknown
  },
): TransformResult["messages"][number] {
  const { id, type, ...data } = message
  return {
    id,
    session_id: source.session_id,
    type,
    seq: 0,
    time_created: source.time_created,
    time_updated: source.time_updated,
    data,
  }
}

function migrateTool(part: typeof SessionV1.ToolPart.Type, fallback: number) {
  const base = {
    type: "tool" as const,
    id: part.callID,
    name: part.tool,
    ...(part.metadata ? { providerState: part.metadata } : {}),
  }
  if (part.state.status === "completed")
    return {
      ...base,
      state: {
        status: "completed",
        input: part.state.input,
        content:
          part.state.time.compacted === undefined
            ? [
                { type: "text", text: part.state.output },
                ...(part.state.attachments ?? []).map((file) => ({
                  type: "file" as const,
                  uri: file.url,
                  mime: file.mime,
                  ...(file.filename ? { name: file.filename } : {}),
                })),
              ]
            : [{ type: "text", text: "[Old tool result content cleared]" }],
        metadata: part.state.metadata,
      },
      time: { created: part.state.time.start, completed: part.state.time.end },
    }
  if (part.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: part.state.input,
        error: { type: "tool.execution", message: part.state.error },
        ...(typeof part.state.metadata?.output === "string"
          ? { content: [{ type: "text", text: part.state.metadata.output }] }
          : {}),
        ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      },
      time: { created: part.state.time.start, completed: part.state.time.end },
    }
  return {
    ...base,
    state: {
      status: "error",
      input: part.state.input,
      error: { type: "tool.interrupted", message: "Tool execution was interrupted before V2 migration" },
      ...(part.state.status === "running" && part.state.metadata ? { metadata: part.state.metadata } : {}),
    },
    time: { created: part.state.status === "running" ? part.state.time.start : fallback },
  }
}

function migrateError(error: NonNullable<(typeof SessionV1.Assistant.Type)["error"]>) {
  const message =
    "message" in error.data
      ? error.data.message
      : error.name === "MessageOutputLengthError"
        ? "The model exceeded its output limit"
        : error.name
  const type =
    error.name === "ProviderAuthError"
      ? "provider.auth"
      : error.name === "ContentFilterError"
        ? "provider.content-filter"
        : error.name === "ContextOverflowError"
          ? "provider.invalid-request"
          : error.name === "StructuredOutputError" || error.name === "MessageOutputLengthError"
            ? "provider.invalid-output"
            : error.name === "MessageAbortedError"
              ? "aborted"
              : error.name === "APIError"
                ? "provider.error"
                : "unknown"
  return { type, message }
}

function normalizeFinish(finish: string | undefined) {
  if (!finish) return undefined
  return (
    (["stop", "length", "tool-calls", "content-filter", "error", "unknown"] as const).find(
      (value) => value === finish,
    ) ?? "unknown"
  )
}

function migrateFile(part: SessionV1.FilePart) {
  if (!part.url.startsWith("data:")) return []
  const comma = part.url.indexOf(",")
  if (comma < 0) return []
  const header = part.url.slice(0, comma)
  const payload = part.url.slice(comma + 1)
  const data = header.endsWith(";base64")
    ? Buffer.from(payload, "base64").toString("base64")
    : Buffer.from(decodeURIComponent(payload)).toString("base64")
  return [
    {
      data,
      mime: part.mime,
      source:
        part.source?.type === "resource" ? { type: "uri" as const, uri: part.source.uri } : { type: "inline" as const },
      ...(part.filename ? { name: part.filename } : {}),
      ...(part.source
        ? { mention: { text: part.source.text.value, start: part.source.text.start, end: part.source.text.end } }
        : {}),
    },
  ]
}

function unavailableFile(part: SessionV1.FilePart) {
  const label = part.filename ?? (part.source?.type === "resource" ? part.source.uri : part.url)
  return `[Attachment unavailable after migration: ${label} (${part.mime})]`
}

function syntheticID(source: string, used: Set<string>) {
  const prefix = source.slice(0, 16)
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  for (let salt = 0; ; salt++) {
    const hex = createHash("sha256")
      .update(`v1-synthetic:${source}${salt ? `:${salt}` : ""}`)
      .digest("hex")
    let value = BigInt(`0x${hex}`)
    let suffix = ""
    while (suffix.length < 14) {
      suffix = alphabet[Number(value % 62n)] + suffix
      value /= 62n
    }
    const id = prefix + suffix
    if (used.has(id)) continue
    used.add(id)
    return id
  }
}

function serializeRecent(
  messages: ReadonlyArray<{ row: SourceMessage; value: typeof SessionV1.Info.Type }>,
  parts: Map<string, Array<{ row: SourcePart; value: typeof SessionV1.Part.Type }>>,
) {
  return messages
    .flatMap((message) => {
      const owned = parts.get(message.row.id)?.map((part) => part.value) ?? []
      if (message.value.role === "user")
        return [
          `[User]: ${owned
            .filter((part) => part.type === "text" && !part.ignored)
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n\n")}`,
        ]
      return owned.flatMap((part) =>
        part.type === "text"
          ? [`[Assistant]: ${part.text}`]
          : part.type === "reasoning" && part.text
            ? [`[Assistant reasoning]: ${part.text}`]
            : [],
      )
    })
    .join("\n\n")
}
