import { SessionID } from "@/session/schema"
import { Event as BaseEvent } from "./event"
import { FileAttachment, Prompt } from "./session-prompt"
import { Schema } from "effect"
export { FileAttachment }

export const ID = BaseEvent.ID
export type ID = Schema.Schema.Type<typeof ID>

export const Source = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
}).annotate({
  identifier: "session.event.source",
})
export type Source = Schema.Schema.Type<typeof Source>

export const Prompted = BaseEvent.define({
  type: "session.prompted",
  aggregate: "sessionID",
  schema: {
    sessionID: SessionID,
    prompt: Prompt,
  },
})
export type Prompted = Schema.Schema.Type<typeof Prompted>

export const Synthetic = BaseEvent.define({
  type: "session.synthetic",
  aggregate: "sessionID",
  schema: {
    sessionID: SessionID,
    text: Schema.String,
  },
})
export type Synthetic = Schema.Schema.Type<typeof Synthetic>

export namespace Step {
  export const Started = BaseEvent.define({
    type: "session.step.started",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
      model: Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.String.pipe(Schema.optional),
      }),
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Ended = BaseEvent.define({
    type: "session.step.ended",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
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
  export const Started = BaseEvent.define({
    type: "session.text.started",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Delta = BaseEvent.define({
    type: "session.text.delta",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
      delta: Schema.String,
    },
  })
  export type Delta = Schema.Schema.Type<typeof Delta>

  export const Ended = BaseEvent.define({
    type: "session.text.ended",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
      text: Schema.String,
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Reasoning {
  export const Started = BaseEvent.define({
    type: "session.reasoning.started",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Delta = BaseEvent.define({
    type: "session.reasoning.delta",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
      delta: Schema.String,
    },
  })
  export type Delta = Schema.Schema.Type<typeof Delta>

  export const Ended = BaseEvent.define({
    type: "session.reasoning.ended",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
      text: Schema.String,
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Tool {
  export namespace Input {
    export const Started = BaseEvent.define({
      type: "session.tool.input.started",
      aggregate: "sessionID",
      schema: {
        sessionID: SessionID,
        callID: Schema.String,
        name: Schema.String,
      },
    })
    export type Started = Schema.Schema.Type<typeof Started>

    export const Delta = BaseEvent.define({
      type: "session.tool.input.delta",
      aggregate: "sessionID",
      schema: {
        sessionID: SessionID,
        callID: Schema.String,
        delta: Schema.String,
      },
    })
    export type Delta = Schema.Schema.Type<typeof Delta>

    export const Ended = BaseEvent.define({
      type: "session.tool.input.ended",
      aggregate: "sessionID",
      schema: {
        sessionID: SessionID,
        callID: Schema.String,
        text: Schema.String,
      },
    })
    export type Ended = Schema.Schema.Type<typeof Ended>
  }

  export const Called = BaseEvent.define({
    type: "session.tool.called",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
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

  export const Success = BaseEvent.define({
    type: "session.tool.success",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
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

  export const Error = BaseEvent.define({
    type: "session.tool.error",
    aggregate: "sessionID",
    schema: {
      sessionID: SessionID,
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

export const Retried = BaseEvent.define({
  type: "session.retried",
  aggregate: "sessionID",
  schema: {
    sessionID: SessionID,
    attempt: Schema.Number,
    error: RetryError,
  },
})
export type Retried = Schema.Schema.Type<typeof Retried>

export const Compacted = BaseEvent.define({
  type: "session.compacted",
  aggregate: "sessionID",
  schema: {
    sessionID: SessionID,
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
