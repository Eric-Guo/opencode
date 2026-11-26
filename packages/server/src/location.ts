import { FileSystem } from "@opencode/core/filesystem"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { FSUtil } from "@opencode/util/fs-util"
import { LocationNotFoundError, InvalidRequestError } from "@opencode/protocol/errors"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { missingSession } from "./handlers/session-error"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
  { error: [LocationNotFoundError] },
) {}

export function locationErrors<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, FileSystem.DirectoryNotFoundError> =>
        error instanceof FileSystem.DirectoryNotFoundError,
      (error) =>
        Effect.fail(
          new LocationNotFoundError({
            location: { directory: error.directory },
            message: `Location not found: ${error.directory}`,
          }),
        ),
    ),
  )
}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const sessionInfo = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: unknown) {
  const id = yield* decodeSessionID(sessionID).pipe(
    Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
  )
  return yield* sessions.get(id).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
})

export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const locationLayer = (createDirectories = true) =>
  Layer.effect(
    LocationMiddleware,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      const fs = yield* FSUtil.Service
      const sessions = yield* Session.Service
      const initialize = Effect.fnUntraced(function* (ref: Location.Ref) {
        if (yield* fs.existsSafe(ref.directory)) return
        // Draft-first clients request catalogs before creating a Session. Preserve 404s for paths
        // that already have a recorded Session, including locations deleted after their first use.
        const recorded = yield* sessions.list({ directory: ref.directory, limit: 1 }).pipe(Effect.orDie)
        if (recorded.data.length > 0) return
        yield* fs.ensureDir(ref.directory).pipe(Effect.orDie)
      })
      return LocationMiddleware.of((effect, options) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const ref = LocationServiceMap.canonical(requestRef(request))

          // VCS initialization requires an existing project directory.
          if (createDirectories && options.endpoint.identifier !== "vcs.init") yield* initialize(ref)

          return yield* effect.pipe(Effect.provide(locations.get(ref)), locationErrors)
        }),
      )
    }),
  )
