import type { ExecutionSnapshot, JsonObject } from "@cybros/agent"
import { Schema } from "effect"

const Json = Schema.Record(Schema.String, Schema.MutableJson)

/** Authoring runs before the first durable admission; notes survive retries and reconnects. */
export const TurnDraft = Schema.Struct({
  body: Json,
  environment: Json,
  lead: Schema.String,
  notes: Schema.Record(Schema.String, Schema.MutableJson),
  tools: Schema.mutable(Schema.Array(Json)),
  steps: Schema.optional(Schema.mutable(Schema.Array(Schema.MutableJson))),
})
export type TurnDraft = typeof TurnDraft.Type
export const TurnRefusal = Schema.Struct({ refused: Schema.Literal(true), reason: Schema.String })
export type TurnRefusal = typeof TurnRefusal.Type
export type TurnFollow = {
  workspace: string
  conversation: string
  run: string
  turn: string
  notes: JsonObject
}
export type TurnGateContext = TurnFollow & { snapshot: ExecutionSnapshot; signal: AbortSignal }
export type TurnGate = {
  run_public_id?: string
  reconsider(context: TurnGateContext): Promise<void> | void
  cancel?(): Promise<void> | void
}
export type ExtensionLifecycle = {
  agents?(): readonly string[]
  author(draft: TurnDraft): Promise<TurnDraft>
  follow(value: TurnFollow): Promise<TurnGate | undefined>
  bindings(value: { workspace: string; conversation: string }): Promise<JsonObject[]>
  describeEnvironment(value: JsonObject): Promise<string>
}

export function isTurnGate(value: unknown): value is TurnGate {
  return (
    typeof value === "object" &&
    value !== null &&
    "reconsider" in value &&
    typeof value.reconsider === "function" &&
    (!("cancel" in value) || typeof value.cancel === "function") &&
    (!("run_public_id" in value) || typeof value.run_public_id === "string")
  )
}
