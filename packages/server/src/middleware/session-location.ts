import { Database } from "@opencode-ai/core/database/database"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Workspace } from "@opencode-ai/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import type { LocationServices } from "../location"
import { mkdir, stat } from "node:fs/promises"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

function sessionNotFound(sessionID: Session.ID) {
  return new SessionNotFoundError({
    sessionID,
    message: `Session not found: ${sessionID}`,
  })
}

const ensureDirectory = Effect.fn("SessionLocation.ensureDirectory")(function* (
  sessionID: Session.ID,
  directory: string,
) {
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true }),
    catch: () => sessionNotFound(sessionID),
  })

  const created = yield* Effect.tryPromise({
    try: () => stat(directory),
    catch: () => sessionNotFound(sessionID),
  })
  if (created.isDirectory()) return
  return yield* sessionNotFound(sessionID)
})

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const row = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* sessionNotFound(sessionID)
        yield* ensureDirectory(sessionID, row.directory)

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                workspaceID: row.workspaceID ? Workspace.ID.make(row.workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
)
