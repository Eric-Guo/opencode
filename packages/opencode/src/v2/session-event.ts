import { Identifier } from "@/id/id"
import { FileAttachment, Prompt } from "./session-prompt"
import { SessionID } from "@/session/schema"
import { SyncEvent } from "@/sync"
import { withStatics } from "@/util/schema"
import { Schema } from "effect"
export { FileAttachment }

export const ID = Schema.String.pipe(
  Schema.brand("Session.Event.ID"),
  withStatics((s) => ({
    create: () => s.make(Identifier.create("evt", "ascending")),
  })),
)
export type ID = Schema.Schema.Type<typeof ID>

function defineEvent<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  type: Type
  schema: Fields
  version?: number
}) {
  const Event = Schema.Struct({
    id: ID,
    sessionID: SessionID,
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    timestamp: Schema.DateTimeUtc,
    type: Schema.Literal(input.type),
    version: Schema.Number.pipe(Schema.optional),
    ...input.schema,
  }).annotate({
    identifier: input.type,
  })

  const Sync = SyncEvent.define({
    type: input.type,
    version: input.version ?? 1,
    aggregate: "sessionID",
    schema: Event,
  })

  return Object.assign(Event, {
    Sync,
  })
}

export const Source = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
}).annotate({
  identifier: "session.event.source",
})
export type Source = Schema.Schema.Type<typeof Source>

export const Prompted = defineEvent({
  type: "session.prompted",
  schema: {
    prompt: Prompt,
  },
})
export type Prompted = Schema.Schema.Type<typeof Prompted>

export const Synthetic = defineEvent({
  type: "session.synthetic",
  schema: {
    text: Schema.String,
  },
})
export type Synthetic = Schema.Schema.Type<typeof Synthetic>

export namespace Step {
  export const Started = defineEvent({
    type: "session.step.started",
    schema: {
      model: Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.String.pipe(Schema.optional),
      }),
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Ended = defineEvent({
    type: "session.step.ended",
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
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Text {
  export const Started = defineEvent({
    type: "session.text.started",
    schema: {},
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Delta = defineEvent({
    type: "session.text.delta",
    schema: {
      delta: Schema.String,
    },
  })
  export type Delta = Schema.Schema.Type<typeof Delta>

  export const Ended = defineEvent({
    type: "session.text.ended",
    schema: {
      text: Schema.String,
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Reasoning {
  export const Started = defineEvent({
    type: "session.reasoning.started",
    schema: {},
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Delta = defineEvent({
    type: "session.reasoning.delta",
    schema: {
      delta: Schema.String,
    },
  })
  export type Delta = Schema.Schema.Type<typeof Delta>

  export const Ended = defineEvent({
    type: "session.reasoning.ended",
    schema: {
      text: Schema.String,
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Tool {
  export namespace Input {
    export const Started = defineEvent({
      type: "session.tool.input.started",
      schema: {
        callID: Schema.String,
        name: Schema.String,
      },
    })
    export type Started = Schema.Schema.Type<typeof Started>

    export const Delta = defineEvent({
      type: "session.tool.input.delta",
      schema: {
        callID: Schema.String,
        delta: Schema.String,
      },
    })
    export type Delta = Schema.Schema.Type<typeof Delta>

    export const Ended = defineEvent({
      type: "session.tool.input.ended",
      schema: {
        callID: Schema.String,
        text: Schema.String,
      },
    })
    export type Ended = Schema.Schema.Type<typeof Ended>
  }

  export const Called = defineEvent({
    type: "session.tool.called",
    schema: {
      callID: Schema.String,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  })
  export type Called = Schema.Schema.Type<typeof Called>

  export const Success = defineEvent({
    type: "session.tool.success",
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
  })
  export type Success = Schema.Schema.Type<typeof Success>

  export const Error = defineEvent({
    type: "session.tool.error",
    schema: {
      callID: Schema.String,
      error: Schema.String,
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  })
  export type Error = Schema.Schema.Type<typeof Error>
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Number.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "session.retry_error",
})
export type RetryError = Schema.Schema.Type<typeof RetryError>

export const Retried = defineEvent({
  type: "session.retried",
  schema: {
    attempt: Schema.Number,
    error: RetryError,
  },
})
export type Retried = Schema.Schema.Type<typeof Retried>

export const Compacted = defineEvent({
  type: "session.compacted",
  schema: {
    auto: Schema.Boolean,
    overflow: Schema.Boolean.pipe(Schema.optional),
  },
})
export type Compacted = Schema.Schema.Type<typeof Compacted>

export const Event = Schema.Union(
  [
    Prompted,
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
