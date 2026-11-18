import { Schema } from "effect"
import { NexusBot } from "@opencode/schema/nexus-bot"

export const TelegramConnectionState = Schema.Struct({
  offset: Schema.Int,
  retry: Schema.optional(Schema.Number),
  identity: Schema.NullOr(Schema.Struct({ id: Schema.String, username: Schema.String })),
})
const Route = Schema.Struct({
  connection: Schema.String,
  chat: Schema.String,
  topic: Schema.NullOr(Schema.Int),
  group: Schema.Boolean,
  destination_bot: Schema.optional(Schema.String),
  destination_owner: Schema.optional(Schema.String),
})
const Locator = Schema.Struct({ workspace: Schema.String, conversation: Schema.String })
const Media = Schema.Struct({
  file_id: Schema.String,
  file_size: Schema.optional(Schema.Number),
  filename: Schema.String,
  content_type: Schema.String,
  kind: Schema.String,
})
export const TelegramBatch = Schema.Struct({
  id: Schema.String,
  route: Route,
  target: Locator,
  requester: Schema.String,
  speaker: Schema.String,
  sources: Schema.Array(
    Schema.Struct({ update: Schema.Int, message: Schema.Int, text: Schema.String, date: Schema.Int }),
  ),
  ready: Schema.Number,
  model: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String),
  observe: Schema.Boolean,
  media: Schema.optional(Media),
  upload: Schema.optional(Schema.String),
  inference: Schema.optional(Schema.String),
  transcript: Schema.optional(Schema.String),
  submission: Schema.optional(NexusBot.Command.members[4]),
})
export type TelegramBatch = typeof TelegramBatch.Type
export const TelegramWork = Schema.Struct({
  id: Schema.String,
  route: Route,
  target: Locator,
  requester: Schema.String,
  speaker: Schema.String,
  source: Schema.Array(Schema.Int),
  input: Schema.String,
  result_route: Schema.optional(Route),
  worker: Schema.optional(Schema.Boolean),
  answerer: Schema.optional(Schema.String),
  delivery_error: Schema.optional(Schema.String),
  candidate: Schema.optional(Schema.Boolean),
  report: Schema.optional(Schema.Boolean),
  execution: Schema.optional(
    Schema.Struct({
      turn_public_id: Schema.String,
      variant_public_id: Schema.NullOr(Schema.String),
      run_public_id: Schema.NullOr(Schema.String),
    }),
  ),
  canonical: Schema.optional(
    Schema.Struct({
      turn_public_id: Schema.String,
      variant_public_id: Schema.String,
      run_public_id: Schema.NullOr(Schema.String),
    }),
  ),
  voice: Schema.Boolean,
  terminal: Schema.optional(Schema.Boolean),
  attention: Schema.optional(Schema.String),
  draft: Schema.optional(Schema.Struct({ id: Schema.Int, run: Schema.String })),
})
export type TelegramWork = typeof TelegramWork.Type
export const TelegramDelivery = Schema.Struct({
  id: Schema.String,
  route: Route,
  requester: Schema.optional(Schema.String),
  target: Schema.optional(Locator),
  input: Schema.optional(Schema.String),
  text: Schema.String,
  kind: Schema.Literals(["notice", "answer", "question", "approval", "voice", "participation", "file"]),
  html: Schema.optional(Schema.String),
  plain: Schema.optional(Schema.Boolean),
  document: Schema.optional(Schema.Boolean),
  execution: Schema.optional(Schema.Struct({ turn: Schema.String, variant: Schema.String, canonical: Schema.Boolean })),
  upload: Schema.optional(
    Schema.Struct({
      public_id: Schema.String,
      filename: Schema.String,
      content_type: Schema.String,
      byte_size: Schema.Number,
    }),
  ),
  task: Schema.optional(Schema.String),
  status: Schema.Literals(["pending", "sending", "sent", "uncertain", "refused", "preparing"]),
  message: Schema.optional(Schema.Int),
  retry: Schema.optional(Schema.Number),
  inference: Schema.optional(Schema.String),
  index: Schema.optional(Schema.Int),
  model: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type TelegramDelivery = typeof TelegramDelivery.Type
export const TelegramState = Schema.Struct({
  consumed: Schema.Record(Schema.String, Schema.Int),
  access: Schema.Struct({
    allowed_users: Schema.Array(Schema.String),
    allowed_chats: Schema.Array(Schema.String),
    ignored_users: Schema.Array(Schema.String),
  }),
  batches: Schema.Array(TelegramBatch),
  work: Schema.Array(TelegramWork),
  deliveries: Schema.Array(TelegramDelivery),
  media_cancellations: Schema.optional(
    Schema.Array(Schema.Struct({ workspace: Schema.String, inference: Schema.String })),
  ),
  messages: Schema.optional(Schema.Array(TelegramDelivery)),
  jobs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        route: Route,
        target: Locator,
        requester: Schema.String,
        speaker: Schema.String,
      }),
    ),
  ),
  queue_selections: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ target: Locator, inputs: Schema.Array(Schema.String) })),
  ),
  history: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ position: Schema.Int, pending: Schema.Array(Schema.String) })),
  ),
  sessions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        cursors: Schema.Record(Schema.String, Schema.String),
        listed: Schema.Record(Schema.String, Schema.String),
        tracked: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  ),
  searches: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.NullOr(
        Schema.Struct({
          query: Schema.String,
          workspaces: Schema.Array(Schema.String),
          after: Schema.NullOr(Schema.String),
        }),
      ),
    ),
  ),
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        route: Route,
        target: Locator,
        requester: Schema.String,
        speaker: Schema.String,
        turn: Schema.String,
        previous: Schema.NullOr(Schema.String),
        known: Schema.Array(Schema.String),
        variant: Schema.optional(Schema.String),
        operation: Schema.optional(Schema.Literals(["activate", "edit", "regenerate"])),
      }),
    ),
  ),
  participation: Schema.optional(
    Schema.Struct({
      after: Schema.Int,
      last_attempt: Schema.Number,
      last_sent: Schema.Number,
      source: Schema.optional(
        Schema.Struct({
          update: Schema.Int,
          at: Schema.Number,
          input: Schema.String,
          requester: Schema.String,
          speaker: Schema.String,
          route: Route,
          target: Locator,
          model: Schema.String,
        }),
      ),
      candidate: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            update: Schema.Int,
            started: Schema.Number,
            prompt: Schema.String,
            model: Schema.String,
            inference: Schema.optional(Schema.String),
            text: Schema.optional(Schema.String),
            target: Locator,
            route: Route,
            requester: Schema.String,
          }),
        ),
      ),
    }),
  ),
  model: Schema.optional(Schema.String),
  observe: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Literals(["assistant", "active"])),
  control: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        update: Schema.Int,
        clock: Schema.optional(Schema.Number),
        workspace: Schema.optional(Schema.String),
        job: Schema.optional(Schema.Struct({ target: Locator, model: Schema.NullOr(Schema.String) })),
        fork: Schema.optional(
          Schema.Struct({ target: Locator, turn: Schema.String, variant: Schema.optional(Schema.String) }),
        ),
        resume: Schema.optional(Schema.Struct({ target: Locator, reply: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  voice: Schema.Literals(["off", "voice_only", "all"]),
})
export type TelegramState = typeof TelegramState.Type
export function telegramState(): TelegramState {
  return {
    consumed: {},
    access: { allowed_users: [], allowed_chats: [], ignored_users: [] },
    batches: [],
    work: [],
    deliveries: [],
    voice: "off",
  }
}
