export * as NexusPreset from "./nexus-preset.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

const Names = Schema.NullOr(Schema.Array(Schema.String))
const Model = Schema.String.check(Schema.isPattern(/^[^\s/]+\/[^\s]+$/))
const Scope = Schema.Literals(["conversation", "workspace", "user", "agent", "speaker"])
const Connection = Schema.Union([
  Schema.Struct({ source: Schema.Literal("nexus"), connection_public_id: Schema.String }),
  Schema.Struct({ source: Schema.Literal("executor"), executor_public_id: Schema.String, server_key: Schema.String }),
])
const Tool = Schema.Union([
  Schema.Struct({ source: Schema.Literal("nexus"), connection_public_id: Schema.String, tool_name: Schema.String }),
  Schema.Struct({
    source: Schema.Literal("executor"),
    executor_public_id: Schema.String,
    server_key: Schema.String,
    tool_name: Schema.String,
  }),
])

export const Configuration = Schema.Struct({
  system_prompt: Schema.NullOr(Schema.String).pipe(optional),
  model: Schema.NullOr(Model).pipe(optional),
  model_mode: Schema.Literals(["default", "follow"]).pipe(optional),
  fallback_models: Schema.NullOr(Schema.Array(Model)).pipe(optional),
  tools: Names.pipe(optional),
  runner_tool_names: Names.pipe(optional),
  mcp: Schema.Struct({ disabled_connections: Schema.Array(Connection), disabled_tools: Schema.Array(Tool) }).pipe(
    optional,
  ),
  prompt_template: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)).pipe(optional),
  approval_mode: Schema.NullOr(Schema.Literals(["bypass", "ask", "rules"])).pipe(optional),
  approval_rules: Schema.NullOr(Schema.Array(Schema.Record(Schema.String, Schema.Json))).pipe(optional),
  compaction_policy: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)).pipe(optional),
  lifecycle_hooks: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)).pipe(optional),
  memory_context_limit: Schema.NullOr(
    Schema.Struct({
      bindings: Schema.Array(
        Schema.Struct({
          name: Scope,
          source: Schema.Struct({ scope: Scope }),
          access: Schema.Literals(["read", "read_write"]),
        }),
      ),
    }),
  ).pipe(optional),
  conversation_reach: Schema.NullOr(Schema.Literals(["workspace", "subtree"])).pipe(optional),
})
export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}

export const Authored = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  configuration: Configuration,
})
export interface Authored extends Schema.Schema.Type<typeof Authored> {}

export const Role = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{1,31}$/)),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
})
export interface Role extends Schema.Schema.Type<typeof Role> {}

export const Entry = Schema.Struct({
  ...Authored.fields,
  public_id: Schema.String,
  role: Schema.NullOr(Role),
})
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const Catalog = Schema.Struct({
  presets: Schema.Array(Entry),
  main_preset_public_id: Schema.String,
  default_bot_preset_public_id: Schema.String,
})
export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}

export const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preset.list") }),
  Schema.Struct({ action: Schema.Literal("preset.create"), value: Authored }),
  Schema.Struct({ action: Schema.Literal("preset.replace"), id: Schema.String, value: Authored }),
  Schema.Struct({ action: Schema.Literal("preset.duplicate"), id: Schema.String, name: Schema.String }),
  Schema.Struct({
    action: Schema.Literals([
      "preset.read",
      "preset.remove",
      "preset.unpublish",
      "preset.select-main",
      "preset.select-default-bot",
      "preset.export",
    ]),
    id: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("preset.publish"), id: Schema.String, role: Role }),
  Schema.Struct({ action: Schema.Literal("preset.import"), value: Authored }),
])
export type Command = typeof Command.Type
