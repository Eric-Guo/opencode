export * as NexusRun from "./nexus-run.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Input = Schema.Struct({
  key: Schema.NonEmptyString,
  prompt: Schema.String,
  model: Schema.String.pipe(optional),
  runner: Schema.NullOr(Schema.String).pipe(optional),
  agent: Schema.String.pipe(optional),
  instructions: Schema.String.pipe(optional),
  directory: Schema.String.pipe(optional),
  attachments: Schema.Array(Schema.String).pipe(optional),
  code_mode: Schema.Boolean.pipe(optional),
  timeout_ms: Schema.Int.check(Schema.isGreaterThan(0)).pipe(optional),
  until: Schema.Struct({
    command: Schema.NonEmptyString,
    attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(optional),
  }).pipe(optional),
})
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Event = Schema.Record(Schema.String, Schema.Json)
export type Event = typeof Event.Type
