import { Instance } from "@opencode-ai/core/instance/service"
import { Session } from "@opencode-ai/core/session"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { sessionInfo, type LocationServices } from "../location"
import { stat } from "node:fs/promises"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

function sessionNotFound(sessionID: Session.ID) {
  return new SessionNotFoundError({
    sessionID,
    message: `Session not found: ${sessionID}`,
  })
}

const requireDirectory = Effect.fn("SessionLocation.requireDirectory")(function* (
  sessionID: Session.ID,
  directory: string,
) {
  const info = yield* Effect.tryPromise({
    try: () => stat(directory),
    catch: () => sessionNotFound(sessionID),
  })
  if (info.isDirectory()) return
  return yield* sessionNotFound(sessionID)
})

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* Instance.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const session = yield* sessionInfo(sessions, route.params.sessionID)
        yield* requireDirectory(session.id, session.location.directory)
        return yield* effect.pipe(instances.provide(session))
      }),
    )
  }),
)
