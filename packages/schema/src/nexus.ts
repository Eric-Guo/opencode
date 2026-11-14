export * as Nexus from "./nexus.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const FieldOperation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("set"), path: Schema.NonEmptyArray(Schema.String), value: Schema.Json }),
  Schema.Struct({ op: Schema.Literal("unset"), path: Schema.NonEmptyArray(Schema.String) }),
])
export type FieldOperation = typeof FieldOperation.Type

export const Extension = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  configuration_version: Schema.Int,
  configuration_schema: Schema.Json,
  enabled: Schema.Boolean,
  active: Schema.Boolean,
  ready: Schema.Boolean,
  restart_required: Schema.Boolean,
  configuration: Schema.Record(Schema.String, Schema.Json),
  diagnostics: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
})
export interface Extension extends Schema.Schema.Type<typeof Extension> {}

export const ExtensionChange = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean.pipe(optional),
  operations: Schema.Array(FieldOperation).pipe(optional),
})
export interface ExtensionChange extends Schema.Schema.Type<typeof ExtensionChange> {}

export const ConfigurationResult = Schema.Struct({
  saved: Schema.Boolean,
  applied: Schema.Boolean,
  published: Schema.Boolean,
  restart_required: Schema.Boolean,
})
export interface ConfigurationResult extends Schema.Schema.Type<typeof ConfigurationResult> {}
