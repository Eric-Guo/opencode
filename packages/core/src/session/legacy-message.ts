export * as LegacyMessage from "./legacy-message"

import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Agent } from "../agent"
import type { Database } from "../database/database"
import { Model } from "../model"
import { Provider } from "../provider"
import { SessionV1 } from "../v1/session"
import { Money } from "@opencode-ai/schema/money"
import { Base64, FileAttachment } from "@opencode-ai/schema/prompt"
import { Snapshot } from "@opencode-ai/schema/snapshot"
import { SessionMessage } from "./message"
import { MessageTable, PartTable } from "./sql"
import type { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]
type MessageRow = typeof MessageTable.$inferSelect
type PartRow = typeof PartTable.$inferSelect
type FilePart = Extract<PartRow["data"], { type: "file" }>
type Order = "asc" | "desc"

const isMetadata = Schema.is(Schema.Record(Schema.String, Schema.Json))

export const list = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: Order
    cursor?: { id: SessionMessage.ID; direction: "previous" | "next" }
  },
) {
  const direction = input.cursor?.direction ?? "next"
  const requestedOrder = input.order ?? "desc"
  const order = direction === "previous" ? reverse(requestedOrder) : requestedOrder
  const anchor = input.cursor
    ? yield* db
        .select({ id: MessageTable.id, time: MessageTable.time_created })
        .from(MessageTable)
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            eq(MessageTable.id, SessionV1.MessageID.ascending(input.cursor.id)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (input.cursor && !anchor) return []
  const boundary = anchor
    ? order === "asc"
      ? or(
          gt(MessageTable.time_created, anchor.time),
          and(eq(MessageTable.time_created, anchor.time), gt(MessageTable.id, anchor.id)),
        )
      : or(
          lt(MessageTable.time_created, anchor.time),
          and(eq(MessageTable.time_created, anchor.time), lt(MessageTable.id, anchor.id)),
        )
    : undefined
  const query = db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID), boundary))
    .orderBy(
      order === "asc" ? asc(MessageTable.time_created) : desc(MessageTable.time_created),
      order === "asc" ? asc(MessageTable.id) : desc(MessageTable.id),
    )
  const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
  if (rows.length === 0) return []
  const parts = yield* db
    .select()
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, input.sessionID),
        inArray(
          PartTable.message_id,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(PartTable.id))
    .all()
    .pipe(Effect.orDie)
  const byMessage = Map.groupBy(parts, (part) => part.message_id)
  return (direction === "previous" ? rows.toReversed() : rows).map((row) => current(row, byMessage.get(row.id) ?? []))
})

function current(row: MessageRow, parts: PartRow[]): SessionMessage.Info {
  if (row.data.role === "user") {
    return SessionMessage.User.make({
      id: SessionMessage.ID.make(row.id),
      type: "user",
      text:
        parts.flatMap((part) => (part.data.type === "text" && !part.data.synthetic ? [part.data.text] : []))[0] ?? "",
      files: parts.flatMap((part) => (part.data.type === "file" ? [file(part.data)] : [])),
      agents: parts.flatMap((part) =>
        part.data.type === "agent"
          ? [
              {
                name: part.data.name,
                mention: part.data.source
                  ? {
                      text: part.data.source.value,
                      start: part.data.source.start,
                      end: part.data.source.end,
                    }
                  : undefined,
              },
            ]
          : [],
      ),
      time: { created: DateTime.makeUnsafe(row.data.time.created) },
    })
  }
  const start = parts.find((part) => part.data.type === "step-start")
  const finish = parts.findLast((part) => part.data.type === "step-finish")
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(row.id),
    type: "assistant",
    agent: Agent.ID.make(row.data.agent || row.data.mode),
    model: Model.Ref.make({
      id: Model.ID.make(row.data.modelID),
      providerID: Provider.ID.make(row.data.providerID),
      variant: row.data.variant ? Model.VariantID.make(row.data.variant) : undefined,
    }),
    content: parts.flatMap((part) => content(part, row.data.time.created)),
    snapshot:
      (start?.data.type === "step-start" && start.data.snapshot) ||
      (finish?.data.type === "step-finish" && finish.data.snapshot)
        ? {
            start:
              start?.data.type === "step-start" && start.data.snapshot
                ? Snapshot.ID.make(start.data.snapshot)
                : undefined,
            end:
              finish?.data.type === "step-finish" && finish.data.snapshot
                ? Snapshot.ID.make(finish.data.snapshot)
                : undefined,
          }
        : undefined,
    finish: finishReason(row.data.finish ?? (finish?.data.type === "step-finish" ? finish.data.reason : undefined)),
    cost: Money.USD.make(row.data.cost),
    tokens: row.data.tokens,
    error: error(row.data.error),
    retry: parts
      .flatMap((part) => (part.data.type === "retry" ? [part.data] : []))
      .map((part) => ({
        attempt: Math.max(1, part.attempt),
        at: DateTime.makeUnsafe(part.time.created),
        error: { type: part.error.name, message: part.error.data.message },
      }))
      .at(-1),
    time: {
      created: DateTime.makeUnsafe(row.data.time.created),
      completed: row.data.time.completed === undefined ? undefined : DateTime.makeUnsafe(row.data.time.completed),
    },
  })
}

function file(part: FilePart) {
  return FileAttachment.make({
    data: Base64.make(""),
    mime: part.mime,
    name: part.filename,
    source: { type: "uri", uri: part.url },
    mention: part.source
      ? {
          text: part.source.text.value,
          start: part.source.text.start,
          end: part.source.text.end,
        }
      : undefined,
  })
}

function content(part: PartRow, created: number): SessionMessage.AssistantContent[] {
  if (part.data.type === "text" && !part.data.ignored) {
    return [
      SessionMessage.AssistantText.make({
        type: "text",
        text: part.data.text,
        state: part.data.metadata,
      }),
    ]
  }
  if (part.data.type === "reasoning") {
    return [
      SessionMessage.AssistantReasoning.make({
        type: "reasoning",
        text: part.data.text,
        state: part.data.metadata,
        time: {
          created: DateTime.makeUnsafe(part.data.time.start),
          completed: part.data.time.end === undefined ? undefined : DateTime.makeUnsafe(part.data.time.end),
        },
      }),
    ]
  }
  if (part.data.type === "file") {
    return [
      SessionMessage.AssistantFile.make({
        type: "file",
        id: part.id,
        mime: part.data.mime,
        filename: part.data.filename,
        url: part.data.url,
      }),
    ]
  }
  if (part.data.type !== "tool") return []
  const time = part.data.state.status === "pending" ? created : part.data.state.time.start
  return [
    SessionMessage.AssistantTool.make({
      type: "tool",
      id: part.data.callID,
      name: part.data.tool,
      time: {
        created: DateTime.makeUnsafe(time),
        ran: part.data.state.status === "pending" ? undefined : DateTime.makeUnsafe(part.data.state.time.start),
        completed:
          part.data.state.status === "completed" || part.data.state.status === "error"
            ? DateTime.makeUnsafe(part.data.state.time.end)
            : undefined,
      },
      state: toolState(part.data.state),
    }),
  ]
}

function toolState(state: SessionV1.ToolState): SessionMessage.ToolState {
  if (state.status === "pending") {
    return SessionMessage.ToolStateStreaming.make({ status: "streaming", input: state.raw })
  }
  if (state.status === "running") {
    return SessionMessage.ToolStateRunning.make({
      status: "running",
      input: state.input,
      metadata: metadata(state.metadata),
    })
  }
  if (state.status === "error") {
    return SessionMessage.ToolStateError.make({
      status: "error",
      input: state.input,
      error: { type: "Tool.Error", message: state.error },
      metadata: metadata(state.metadata),
    })
  }
  return SessionMessage.ToolStateCompleted.make({
    status: "completed",
    input: state.input,
    content: [
      { type: "text", text: state.output },
      ...(state.attachments ?? []).map((attachment) => ({
        type: "file" as const,
        uri: attachment.url,
        mime: attachment.mime,
        name: attachment.filename,
      })),
    ],
    metadata: metadata(state.metadata),
  })
}

function metadata(value: unknown) {
  return isMetadata(value) ? value : {}
}

function finishReason(value?: string): SessionMessage.Assistant["finish"] {
  if (value === "stop" || value === "length" || value === "tool-calls" || value === "content-filter") return value
  if (value === "tool_calls") return "tool-calls"
  if (value) return "unknown"
  return undefined
}

function error(value: SessionV1.Assistant["error"]): SessionMessage.Assistant["error"] {
  if (!value) return undefined
  return {
    type: value.name,
    message: "message" in value.data && typeof value.data.message === "string" ? value.data.message : value.name,
  }
}

function reverse(order: Order): Order {
  return order === "asc" ? "desc" : "asc"
}
