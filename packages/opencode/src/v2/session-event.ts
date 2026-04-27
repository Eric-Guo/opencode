import { SessionID } from "@/session/schema"
import { Event } from "./event"
import { FileAttachment, Prompt } from "./session-prompt"
import { Schema } from "effect"
export { FileAttachment }
import { ToolOutput } from "./tool-output"

export const ID = Event.ID
export type ID = Schema.Schema.Type<typeof ID>

export const Source = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export type Source = Schema.Schema.Type<typeof Source>

const Base = {
  timestamp: Schema.DateTimeUtcFromMillis,
  sessionID: SessionID,
}

export const Prompted = Event.define({
  type: "session.next.prompted",
  aggregate: "sessionID",
  version: 1,
  schema: {
    ...Base,
    prompt: Prompt,
  },
})
export type Prompted = Schema.Schema.Type<typeof Prompted>

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  aggregate: "sessionID",
  schema: {
    ...Base,
    text: Schema.String,
  },
})
export type Synthetic = Schema.Schema.Type<typeof Synthetic>

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    aggregate: "sessionID",
    schema: {
      ...Base,
      model: Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.String.pipe(Schema.optional),
      }),
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Ended = Event.define({
    type: "session.next.step.ended",
    aggregate: "sessionID",
    schema: {
      ...Base,
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
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    aggregate: "sessionID",
    schema: {
      ...Base,
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Delta = Event.define({
    type: "session.next.text.delta",
    aggregate: "sessionID",
    schema: {
      ...Base,
      delta: Schema.String,
    },
  })
  export type Delta = Schema.Schema.Type<typeof Delta>

  export const Ended = Event.define({
    type: "session.next.text.ended",
    aggregate: "sessionID",
    schema: {
      ...Base,
      text: Schema.String,
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    aggregate: "sessionID",
    schema: {
      ...Base,
      reasoningID: Schema.String,
    },
  })
  export type Started = Schema.Schema.Type<typeof Started>

  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    aggregate: "sessionID",
    schema: {
      ...Base,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = Schema.Schema.Type<typeof Delta>

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    aggregate: "sessionID",
    schema: {
      ...Base,
      reasoningID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = Schema.Schema.Type<typeof Ended>
}

export namespace Tool {
  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      aggregate: "sessionID",
      schema: {
        ...Base,
        callID: Schema.String,
        name: Schema.String,
      },
    })
    export type Started = Schema.Schema.Type<typeof Started>

    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      aggregate: "sessionID",
      schema: {
        ...Base,
        callID: Schema.String,
        delta: Schema.String,
      },
    })
    export type Delta = Schema.Schema.Type<typeof Delta>

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      aggregate: "sessionID",
      schema: {
        ...Base,
        callID: Schema.String,
        text: Schema.String,
      },
    })
    export type Ended = Schema.Schema.Type<typeof Ended>
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    aggregate: "sessionID",
    schema: {
      ...Base,
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

  export const Progress = Event.define({
    type: "session.next.tool.progress",
    aggregate: "sessionID",
    schema: {
      ...Base,
      callID: Schema.String,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
    },
  })
  export type Progress = Schema.Schema.Type<typeof Progress>

  export const Success = Event.define({
    type: "session.next.tool.success",
    aggregate: "sessionID",
    schema: {
      ...Base,
      callID: Schema.String,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  })
  export type Success = Schema.Schema.Type<typeof Success>

  export const Error = Event.define({
    type: "session.next.tool.error",
    aggregate: "sessionID",
    schema: {
      ...Base,
      callID: Schema.String,
      error: Schema.Struct({
        type: Schema.String,
        message: Schema.String,
      }),
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
  identifier: "session.next.retry_error",
})
export type RetryError = Schema.Schema.Type<typeof RetryError>

export const Retried = Event.define({
  type: "session.next.retried",
  aggregate: "sessionID",
  schema: {
    ...Base,
    attempt: Schema.Number,
    error: RetryError,
  },
})
export type Retried = Schema.Schema.Type<typeof Retried>

export const Compacted = Event.define({
  type: "session.next.compacted",
  aggregate: "sessionID",
  schema: {
    ...Base,
    auto: Schema.Boolean,
    overflow: Schema.Boolean.pipe(Schema.optional),
  },
})
export type Compacted = Schema.Schema.Type<typeof Compacted>

export const All = Schema.Union(
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
    Tool.Progress,
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

export type Event = Schema.Schema.Type<typeof All>
export type Type = Event["type"]

export * as SessionEvent from "./session-event"
