import { Identifier } from "@/id/id"
import { withStatics } from "@/util/schema"
import { Schema } from "effect"
import { SyncEvent } from "@/sync"
import { SessionID } from "@/session/schema"
import * as DateTime from "effect/DateTime"

export const ID = Schema.String.pipe(
  Schema.brand("Session.Event.ID"),
  withStatics((s) => ({
    create: () => s.make(Identifier.create("evt", "ascending")),
  })),
)
export type ID = Schema.Schema.Type<typeof ID>
type Stamp = Schema.Schema.Type<typeof Schema.DateTimeUtc>
type BaseInput = {
  id?: ID
  sessionID: SessionID
  metadata?: Record<string, unknown>
  timestamp?: Stamp
}

function defineEvent<Self>(identifier: string) {
  return <const Type extends string, Fields extends Schema.Struct.Fields>(input: {
    type: Type
    schema: Fields
    version?: number
  }) => {
    const RawEvent = Schema.Class<Self>(identifier)({
      id: ID,
      sessionID: SessionID,
      metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      timestamp: Schema.DateTimeUtc,
      type: Schema.Literal(input.type),
      ...input.schema,
    })
    const Event = RawEvent as Exclude<typeof RawEvent, string>

    const Sync = SyncEvent.define({
      type: input.type,
      version: input.version ?? 1,
      aggregate: "sessionID",
      schema: Event,
    })

    return Object.assign(Event, {
      Sync,
      create(value: BaseInput & Record<string, unknown>) {
        return new (Event as unknown as new (value: Record<string, unknown>) => Self)({
          ...value,
          id: value.id ?? ID.create(),
          sessionID: value.sessionID,
          timestamp: value.timestamp ?? DateTime.makeUnsafe(Date.now()),
          type: input.type,
        })
      },
    })
  }
}

export class Source extends Schema.Class<Source>("Session.Event.Source")({
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
}) {}

export class FileAttachment extends Schema.Class<FileAttachment>("Session.Event.FileAttachment")({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  source: Source.pipe(Schema.optional),
}) {
  static create(input: FileAttachment) {
    return new FileAttachment({
      uri: input.uri,
      mime: input.mime,
      name: input.name,
      description: input.description,
      source: input.source,
    })
  }
}

export class AgentAttachment extends Schema.Class<AgentAttachment>("Session.Event.AgentAttachment")({
  name: Schema.String,
  source: Source.pipe(Schema.optional),
}) {}

export class RetryError extends Schema.Class<RetryError>("Session.Event.Retry.Error")({
  message: Schema.String,
  statusCode: Schema.Number.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}) {}

export class Prompt extends defineEvent<Prompt>("Session.Event.Prompt")({
  type: "prompt",
  schema: {
    text: Schema.String,
    files: Schema.Array(FileAttachment).pipe(Schema.optional),
    agents: Schema.Array(AgentAttachment).pipe(Schema.optional),
  },
}) {}

export class Synthetic extends defineEvent<Synthetic>("Session.Event.Synthetic")({
  type: "synthetic",
  schema: {
    text: Schema.String,
  },
}) {}

export namespace Step {
  export class Started extends defineEvent<Started>("Session.Event.Step.Started")({
    type: "step.started",
    schema: {
      model: Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.String.pipe(Schema.optional),
      }),
    },
  }) {}

  export class Ended extends defineEvent<Ended>("Session.Event.Step.Ended")({
    type: "step.ended",
    schema: {
      reason: Schema.String,
      cost: Schema.Number,
      tokens: Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cache: Schema.Struct({
          read: Schema.Number,
          write: Schema.Number,
        }),
      }),
    },
  }) {}
}

export namespace Text {
  export class Started extends defineEvent<Started>("Session.Event.Text.Started")({
    type: "text.started",
    schema: {},
  }) {}

  export class Delta extends defineEvent<Delta>("Session.Event.Text.Delta")({
    type: "text.delta",
    schema: {
      delta: Schema.String,
    },
  }) {}

  export class Ended extends defineEvent<Ended>("Session.Event.Text.Ended")({
    type: "text.ended",
    schema: {
      text: Schema.String,
    },
  }) {}
}

export namespace Reasoning {
  export class Started extends defineEvent<Started>("Session.Event.Reasoning.Started")({
    type: "reasoning.started",
    schema: {},
  }) {}

  export class Delta extends defineEvent<Delta>("Session.Event.Reasoning.Delta")({
    type: "reasoning.delta",
    schema: {
      delta: Schema.String,
    },
  }) {}

  export class Ended extends defineEvent<Ended>("Session.Event.Reasoning.Ended")({
    type: "reasoning.ended",
    schema: {
      text: Schema.String,
    },
  }) {}
}

export namespace Tool {
  export namespace Input {
    export class Started extends defineEvent<Started>("Session.Event.Tool.Input.Started")({
      type: "tool.input.started",
      schema: {
        callID: Schema.String,
        name: Schema.String,
      },
    }) {}

    export class Delta extends defineEvent<Delta>("Session.Event.Tool.Input.Delta")({
      type: "tool.input.delta",
      schema: {
        callID: Schema.String,
        delta: Schema.String,
      },
    }) {}

    export class Ended extends defineEvent<Ended>("Session.Event.Tool.Input.Ended")({
      type: "tool.input.ended",
      schema: {
        callID: Schema.String,
        text: Schema.String,
      },
    }) {}
  }

  export class Called extends defineEvent<Called>("Session.Event.Tool.Called")({
    type: "tool.called",
    schema: {
      callID: Schema.String,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  }) {}

  export class Success extends defineEvent<Success>("Session.Event.Tool.Success")({
    type: "tool.success",
    schema: {
      callID: Schema.String,
      title: Schema.String,
      output: Schema.String.pipe(Schema.optional),
      attachments: Schema.Array(FileAttachment).pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  }) {}

  export class Error extends defineEvent<Error>("Session.Event.Tool.Error")({
    type: "tool.error",
    schema: {
      callID: Schema.String,
      error: Schema.String,
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  }) {}
}

export class Retried extends defineEvent<Retried>("Session.Event.Retried")({
  type: "retried",
  schema: {
    attempt: Schema.Number,
    error: RetryError,
  },
}) {}

export class Compacted extends defineEvent<Compacted>("Session.Event.Compacted")({
  type: "compacted",
  schema: {
    auto: Schema.Boolean,
    overflow: Schema.Boolean.pipe(Schema.optional),
  },
}) {}

export const Event = Schema.Union(
  [
    Prompt,
    Synthetic,
    Step.Started,
    Step.Ended,
    Text.Started,
    Text.Delta,
    Text.Ended,
    Tool.Input.Started,
    Tool.Input.Delta,
    Tool.Input.Ended,
    Tool.Called,
    Tool.Success,
    Tool.Error,
    Reasoning.Started,
    Reasoning.Delta,
    Reasoning.Ended,
    Retried,
    Compacted,
  ],
  {
    mode: "oneOf",
  },
).pipe(Schema.toTaggedUnion("type"))
export type Event = Schema.Schema.Type<typeof Event>
export type Type = Event["type"]

export * as SessionEvent from "./session-event"
