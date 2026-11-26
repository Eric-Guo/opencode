import { Schema } from "effect"

const ID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const AgentKey = Schema.String.check(
  Schema.isPattern(/^(personal|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/),
)
const Connection = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(100))),
  enabled: Schema.optional(Schema.Boolean),
  token: Schema.optional(Schema.String),
})
const Binding = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  connection_public_id: Schema.optional(Schema.NullOr(ID)),
  target: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        chat_id: Schema.String.check(Schema.isPattern(/^-?[1-9][0-9]*$/)),
        topic_id: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
      }),
    ),
  ),
  owner_id: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)))),
  stale_after: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  input_debounce_seconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  transcription_model: Schema.optional(Schema.String),
  speech_model: Schema.optional(Schema.String),
})
const Settings = Schema.Struct({
  connections: Schema.optional(Schema.Record(ID, Connection)),
  bots: Schema.optional(Schema.Record(AgentKey, Binding)),
})

export class TelegramSettings {
  readonly connections
  readonly bots

  constructor(input: unknown) {
    const value = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" })(input)
    this.connections = Object.fromEntries(
      Object.entries(value.connections ?? {}).map(([id, connection]) => [
        id,
        {
          name: connection.name?.trim() ?? "Telegram",
          enabled: connection.enabled ?? true,
          token: connection.token?.trim() ?? "",
        },
      ]),
    )
    const tokens = Object.values(this.connections)
      .map((connection) => connection.token)
      .filter(Boolean)
    if (new Set(tokens).size !== tokens.length)
      throw new Error("A Telegram token is already configured for another Connection.")
    const targets = new Set<string>()
    this.bots = Object.fromEntries(
      Object.entries(value.bots ?? {}).map(([id, binding]) => {
        const connection = binding.connection_public_id ?? null
        const target = binding.target
          ? { chat_id: binding.target.chat_id, topic_id: binding.target.topic_id ?? null }
          : null
        if (connection && !this.connections[connection])
          throw new Error("The selected Telegram Connection does not exist.")
        if (target?.topic_id && !target.chat_id.startsWith("-"))
          throw new Error("Telegram topics require a group target.")
        if (binding.enabled && (!connection || !target))
          throw new Error("An enabled Telegram Bot requires a Connection and target.")
        if (connection && target) {
          const key = JSON.stringify([connection, target])
          if (targets.has(key)) throw new Error("This Telegram Connection target is already bound to another Bot.")
          targets.add(key)
        }
        return [
          id,
          {
            enabled: binding.enabled ?? false,
            connection_public_id: connection,
            target,
            owner_id: binding.owner_id ?? null,
            stale_after: binding.stale_after ?? 600,
            input_debounce_seconds: binding.input_debounce_seconds ?? 2,
            transcription_model: binding.transcription_model?.trim() ?? "",
            speech_model: binding.speech_model?.trim() ?? "",
          },
        ]
      }),
    )
  }
}
export type TelegramBinding = TelegramSettings["bots"][string]

export const telegramConfiguration = {
  type: "object",
  additionalProperties: false,
  properties: {
    connections: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          enabled: { type: "boolean" },
          token: { type: "string", writeOnly: true },
        },
      },
    },
    bots: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          connection_public_id: { type: ["string", "null"] },
          owner_id: { type: ["string", "null"] },
          stale_after: { type: "integer", minimum: 1 },
          input_debounce_seconds: { type: "integer", minimum: 0, maximum: 10 },
          transcription_model: { type: "string" },
          speech_model: { type: "string" },
          target: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["chat_id"],
            properties: { chat_id: { type: "string" }, topic_id: { type: ["integer", "null"], minimum: 1 } },
          },
        },
      },
    },
  },
} as const
