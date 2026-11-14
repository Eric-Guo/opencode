import { Schema } from "effect"
import { Nexus } from "@opencode/schema/nexus"
import { NexusPreset } from "@opencode/schema/nexus-preset"
import { NexusBot } from "@opencode/schema/nexus-bot"

const Rule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), run_at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("interval"), starts_at: Schema.String, every_seconds: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("daily"), local_time: Schema.String, time_zone: Schema.String }),
])
export const NexusCommand = Schema.Union([
  ...NexusPreset.Command.members,
  ...NexusBot.Command.members,
  Schema.Struct({ action: Schema.Literal("persona.read") }),
  Schema.Struct({ action: Schema.Literal("persona.reset") }),
  Schema.Struct({ action: Schema.Literal("persona.write"), content: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("application.open"),
    key: Schema.NonEmptyString,
    title: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("application.submit"),
    key: Schema.NonEmptyString,
    workspace: Schema.String,
    conversation: Schema.String,
    text: Schema.String,
    model: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    delivery: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
  }),
  Schema.Struct({
    action: Schema.Literal("application.result"),
    workspace: Schema.String,
    conversation: Schema.String,
    input: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("extension.list") }),
  Schema.Struct({ action: Schema.Literal("extension.configure"), change: Nexus.ExtensionChange }),
  Schema.Struct({
    action: Schema.Literal("schedule.create"),
    conversation: Schema.String,
    key: Schema.NonEmptyString,
    prompt: Schema.String,
    name: Schema.optional(Schema.String),
    rule: Rule,
  }),
  Schema.Struct({
    action: Schema.Literals([
      "schedule.pause",
      "schedule.resume",
      "schedule.cancel",
      "schedule.run",
      "schedule.read",
      "schedule.executions",
    ]),
    conversation: Schema.String,
    id: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("schedule.update"),
    conversation: Schema.String,
    id: Schema.String,
    version: Schema.Int,
    prompt: Schema.String,
    rule: Rule,
  }),
  Schema.Struct({ action: Schema.Literal("memory.create"), name: Schema.String }),
  Schema.Struct({
    action: Schema.Literals(["memory.list", "memory.read", "memory.grep"]),
    collection: Schema.String,
    path: Schema.optional(Schema.String),
    pattern: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("memory.write"),
    collection: Schema.String,
    path: Schema.String,
    content: Schema.String,
    id: Schema.NullOr(Schema.String),
    version: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({
    action: Schema.Literal("memory.delete"),
    collection: Schema.String,
    path: Schema.String,
    id: Schema.String,
    version: Schema.Int,
  }),
  Schema.Struct({
    action: Schema.Literals(["memory.archive", "memory.restore"]),
    collection: Schema.String,
    version: Schema.Int,
  }),
])

export const NexusOperator = Schema.Struct({
  workspace: Schema.String,
  conversation: Schema.String,
  runner: Schema.String,
  receipt: Schema.NonEmptyString,
  operation: Schema.Union([
    Schema.Struct({ tool: Schema.Literal("files_bytes"), path: Schema.String }),
    Schema.Struct({ tool: Schema.Literal("checkpoint_restore"), run: Schema.String, task: Schema.String }),
  ]),
})
