import { Database } from "@opencode-ai/core/database/database"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Session } from "@opencode-ai/core/session"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { sessionRef, type LocationServices } from "../location"
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
    const database = yield* Database.Service
    const locations = yield* LocationServiceMap.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = route.params.sessionID
        if (!sessionID)
          return yield* new InvalidRequestError({
            message: "Invalid session ID",
            field: "sessionID",
          })
        const ref = yield* sessionRef(database, sessionID)
        yield* requireDirectory(Session.ID.make(sessionID), ref.directory)
        return yield* effect.pipe(Effect.provide(locations.get(ref)))
      }),
    )
  }),
)
