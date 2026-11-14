export * as NexusBot from "./nexus-bot.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Settings = Schema.Struct({
  audience: Schema.Literals(["owner", "external"]),
  home_workspace_public_id: Schema.NullOr(Schema.String),
  preset_public_id: Schema.String,
  welcome_message: Schema.NullOr(Schema.String),
  subagent: Schema.Boolean,
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const Patch = Schema.Struct({
  audience: Schema.Literals(["owner", "external"]).pipe(optional),
  home_workspace_public_id: Schema.NullOr(Schema.String).pipe(optional),
  preset_public_id: Schema.String.pipe(optional),
  welcome_message: Schema.NullOr(Schema.String).pipe(optional),
  subagent: Schema.Boolean.pipe(optional),
})

export const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("bot.list") }),
  Schema.Struct({
    action: Schema.Literal("bot.create"),
    name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
    description: Schema.NonEmptyString,
    display_name: Schema.String.pipe(optional),
    settings: Patch,
  }),
  Schema.Struct({
    action: Schema.Literal("bot.configure"),
    id: Schema.String,
    settings: Patch,
    display_name: Schema.String.pipe(optional),
    description: Schema.NonEmptyString.pipe(optional),
  }),
  Schema.Struct({
    action: Schema.Literal("bot.duplicate"),
    id: Schema.String,
    name: Schema.String,
    audience: Schema.Literals(["owner", "external"]).pipe(optional),
  }),
  Schema.Struct({
    action: Schema.Literal("bot.submit"),
    id: Schema.String,
    workspace: Schema.String,
    conversation: Schema.String,
    key: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
    model: Schema.String.pipe(optional),
    speaker: Schema.String.pipe(optional),
  }),
  Schema.Struct({ action: Schema.Literals(["bot.read", "bot.remove", "bot.history"]), id: Schema.String }),
  Schema.Struct({ action: Schema.Literals(["bot.current", "bot.new"]), id: Schema.String, key: Schema.NonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("bot.resume"),
    id: Schema.String,
    key: Schema.NonEmptyString,
    conversation: Schema.String,
    workspace: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("bot.fork"),
    id: Schema.String,
    key: Schema.NonEmptyString,
    conversation: Schema.String,
    workspace: Schema.String,
    turn: Schema.String,
    variant: Schema.String.pipe(optional),
  }),
])
export type Command = typeof Command.Type
