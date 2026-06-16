import { AuthWellKnown } from "@opencode-ai/core/auth-well-known"
import { Effect, Layer } from "effect"

export const AuthWellKnownTest = {
  empty: Layer.succeed(
    AuthWellKnown.Service,
    AuthWellKnown.Service.of({
      all: () => Effect.succeed({}),
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
      remove: () => Effect.void,
      metadata: () => Effect.die("not implemented"),
      configs: () => Effect.succeed([]),
    }),
  ),
}
