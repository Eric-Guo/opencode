export * as NexusSettings from "./nexus-settings.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Values = Schema.Struct({
  default_model: Schema.NullOr(Schema.NonEmptyString),
  fallback_models: Schema.Array(Schema.NonEmptyString),
  kernel_tools: Schema.Array(Schema.NonEmptyString),
  subagent_default: Schema.Boolean,
  adaptations: Schema.NonEmptyString,
  adaptations_dir: Schema.NullOr(Schema.String),
  conversation_title_model: Schema.NullOr(Schema.NonEmptyString),
})
export interface Values extends Schema.Schema.Type<typeof Values> {}

export const Patch = Schema.Struct({
  default_model: Schema.NullOr(Schema.NonEmptyString).pipe(optional),
  fallback_models: Schema.Array(Schema.NonEmptyString).pipe(optional),
  kernel_tools: Schema.Array(Schema.NonEmptyString).pipe(optional),
  subagent_default: Schema.Boolean.pipe(optional),
  adaptations: Schema.NonEmptyString.pipe(optional),
  adaptations_dir: Schema.NullOr(Schema.String).pipe(optional),
  conversation_title_model: Schema.NullOr(Schema.NonEmptyString).pipe(optional),
})
export interface Patch extends Schema.Schema.Type<typeof Patch> {}
