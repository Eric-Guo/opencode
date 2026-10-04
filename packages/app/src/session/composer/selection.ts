import { Option, Predicate, Schema } from "effect"
import type { SessionMessageUser } from "@opencode/client/promise"
import { Persistence } from "@/runtime/persistence/schema"

export function resolveSessionComposerSelection(
  info: { agent?: string; model?: { id: string; providerID: string; variant?: string } } | undefined,
  metadata: SessionMessageUser["metadata"],
) {
  const historical = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Struct({
        providerID: Schema.String,
        modelID: Schema.String,
        variant: Persistence.optional(Schema.String),
      }),
    )(metadata?.model),
  )

  return {
    agent: info?.agent ?? (Predicate.isString(metadata?.agent) ? metadata.agent : undefined),
    model: info?.model
      ? { providerID: info.model.providerID, modelID: info.model.id, variant: info.model.variant }
      : historical,
  }
}
