import { Schema } from "effect"
import { Prompt } from "./session-prompt"
import { SessionEvent } from "./session-event"
import { Event } from "./event"

export const ID = Event.ID
export type ID = Schema.Schema.Type<typeof ID>

const Base = {
  id: ID,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  time: Schema.Struct({
    created: Schema.DateTimeUtc,
  }),
}

export class User extends Schema.Class<User>("Session.Message.User")({
  ...Base,
  text: Prompt.fields.text,
  files: Prompt.fields.files,
  agents: Prompt.fields.agents,
  type: Schema.Literal("user"),
  time: Schema.Struct({
    created: Schema.DateTimeUtc,
  }),
}) {
  static fromEvent(event: SessionEvent.Prompted) {
    return new User({
      id: ID.create(),
      type: "user",
      metadata: event.metadata,
      text: event.data.prompt.text,
      files: event.data.prompt.files,
      agents: event.data.prompt.agents,
      time: { created: event.data.timestamp },
    })
  }
}

export class Synthetic extends Schema.Class<Synthetic>("Session.Message.Synthetic")({
  ...Base,
  sessionID: SessionEvent.Synthetic.fields.data.fields.sessionID,
  text: SessionEvent.Synthetic.fields.data.fields.text,
  type: Schema.Literal("synthetic"),
}) {
  static fromEvent(event: SessionEvent.Synthetic) {
    return new Synthetic({
      sessionID: event.data.sessionID,
      text: event.data.text,
      id: ID.create(),
      type: "synthetic",
      time: { created: event.data.timestamp },
    })
  }
}

export class ToolStatePending extends Schema.Class<ToolStatePending>("Session.Message.ToolState.Pending")({
  status: Schema.Literal("pending"),
  input: Schema.String,
}) {}

export class ToolStateRunning extends Schema.Class<ToolStateRunning>("Session.Message.ToolState.Running")({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  details: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

export class ToolStateCompleted extends Schema.Class<ToolStateCompleted>("Session.Message.ToolState.Completed")({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  output: Schema.String,
  details: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  attachments: SessionEvent.FileAttachment.pipe(Schema.Array, Schema.optional),
}) {}

export class ToolStateError extends Schema.Class<ToolStateError>("Session.Message.ToolState.Error")({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  error: Schema.String,
  details: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

export const ToolState = Schema.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError]).pipe(
  Schema.toTaggedUnion("status"),
)
export type ToolState = Schema.Schema.Type<typeof ToolState>

export class AssistantTool extends Schema.Class<AssistantTool>("Session.Message.Assistant.Tool")({
  type: Schema.Literal("tool"),
  callID: Schema.String,
  name: Schema.String,
  state: ToolState,
  time: Schema.Struct({
    created: Schema.DateTimeUtc,
    ran: Schema.DateTimeUtc.pipe(Schema.optional),
    completed: Schema.DateTimeUtc.pipe(Schema.optional),
    pruned: Schema.DateTimeUtc.pipe(Schema.optional),
  }),
}) {}

export class AssistantText extends Schema.Class<AssistantText>("Session.Message.Assistant.Text")({
  type: Schema.Literal("text"),
  text: Schema.String,
}) {}

export class AssistantReasoning extends Schema.Class<AssistantReasoning>("Session.Message.Assistant.Reasoning")({
  type: Schema.Literal("reasoning"),
  reasoningID: Schema.String,
  text: Schema.String,
}) {}

export class AssistantRetry extends Schema.Class<AssistantRetry>("Session.Message.Assistant.Retry")({
  attempt: Schema.Number,
  error: SessionEvent.RetryError,
  time: Schema.Struct({
    created: Schema.DateTimeUtc,
  }),
}) {
  static fromEvent(event: SessionEvent.Retried) {
    return new AssistantRetry({
      attempt: event.data.attempt,
      error: event.data.error,
      time: {
        created: event.data.timestamp,
      },
    })
  }
}

export const AssistantContent = Schema.Union([AssistantText, AssistantReasoning, AssistantTool]).pipe(
  Schema.toTaggedUnion("type"),
)
export type AssistantContent = Schema.Schema.Type<typeof AssistantContent>

// GET /v2/session/{sessionID}/message?limit=10
// user
// synthetic
// synthetic
// assistant HTTP req/retried 5 times/response
// compaction
// assistant
// user

export class Assistant extends Schema.Class<Assistant>("Session.Message.Assistant")({
  ...Base,
  type: Schema.Literal("assistant"),
  content: AssistantContent.pipe(Schema.Array),
  retries: AssistantRetry.pipe(Schema.Array, Schema.optional),
  cost: Schema.Number.pipe(Schema.optional),
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cache: Schema.Struct({
      read: Schema.Number,
      write: Schema.Number,
    }),
  }).pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
  time: Schema.Struct({
    created: Schema.DateTimeUtc,
    completed: Schema.DateTimeUtc.pipe(Schema.optional),
  }),
}) {
  static fromEvent(event: SessionEvent.Step.Started) {
    return new Assistant({
      id: ID.create(),
      type: "assistant",
      time: {
        created: event.data.timestamp,
      },
      content: [],
      retries: [],
    })
  }
}

export class Compaction extends Schema.Class<Compaction>("Session.Message.Compaction")({
  type: Schema.Literal("compaction"),
  sessionID: SessionEvent.Compacted.fields.data.fields.sessionID,
  auto: SessionEvent.Compacted.fields.data.fields.auto,
  overflow: SessionEvent.Compacted.fields.data.fields.overflow,
  ...Base,
}) {
  static fromEvent(event: SessionEvent.Compacted) {
    return new Compaction({
      sessionID: event.data.sessionID,
      auto: event.data.auto,
      overflow: event.data.overflow,
      id: ID.create(),
      type: "compaction",
      time: { created: event.data.timestamp },
    })
  }
}

export const Message = Schema.Union([User, Synthetic, Assistant, Compaction]).pipe(Schema.toTaggedUnion("type"))

export type Message = Schema.Schema.Type<typeof Message>

export type Type = Message["type"]

/*
export interface Interface {
  readonly decode: (row: typeof SessionMessageTable.$inferSelect) => Message
  readonly fromSession: (sessionID: SessionID) => Effect.Effect<Message[], never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMessage") {}

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decodeMessage = Schema.decodeUnknownSync(Message)

    const decode: (typeof Service.Service)["decode"] = (row) => decodeMessage({ ...row, id: row.id, type: row.type })

    const fromSession = Effect.fn("SessionMessage.fromSession")(function* (sessionID: SessionID) {
      return Database.use((db) =>
        db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(SessionMessageTable.id)
          .all()
          .map((row) => decode(row)),
      )
    })

    return Service.of({
      decode,
      fromSession,
    })
  }),
)
*/

export * as SessionMessage from "./session-message"
