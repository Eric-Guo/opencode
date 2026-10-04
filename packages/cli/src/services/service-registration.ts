export * as ServiceRegistration from "./service-registration"

import { Service, type Info } from "@opencode/client/effect/service"
import { DatabaseProcessOwner } from "@opencode/core/database/process-owner"
import path from "node:path"
import { Effect, FileSystem, Schedule, Schema } from "effect"
import { HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { OPENCODE_VERSION } from "../version"

const infoJson = Schema.fromJsonString(Service.Info)
const encodeInfo = Schema.encodeEffect(infoJson)
const decodeInfo = Schema.decodeUnknownEffect(infoJson)

export const register = Effect.fnUntraced(function* (options: {
  readonly address: NetAddress.SocketAddress
  readonly password: string
  readonly id: string
  readonly file: string
  readonly shutdown: Effect.Effect<void>
}) {
  const fs = yield* FileSystem.FileSystem
  const temp = options.file + "." + options.id + ".tmp"
  yield* fs.makeDirectory(path.dirname(options.file), { recursive: true })
  const directory = yield* fs.realPath(path.dirname(options.file))
  yield* DatabaseProcessOwner.lease(
    path.join(directory, path.basename(options.file) + ".owner"),
    "Another managed service owns this registration",
  )
  const previous = yield* fs.readFileString(options.file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  )
  if (previous !== undefined) {
    const owner = yield* decodeInfo(previous)
    if ((yield* Service.ownerAlive(owner)) !== false)
      return yield* Effect.fail(new Error("A live service still owns this registration"))
  }
  const info = {
    id: options.id,
    version: OPENCODE_VERSION,
    url: NetAddress.isInetAddress(options.address)
      ? localURL(NetAddress.formatIp(options.address.address), options.address.port)
      : HttpServer.formatAddress(options.address),
    pid: process.pid,
    password: options.password,
    provenance: yield* Service.provenance,
  }
  const encoded = yield* encodeInfo(info)
  const current = fs.readFileString(options.file).pipe(Effect.flatMap(decodeInfo))
  const owns = (found: Info) =>
    found.id === info.id &&
    found.version === info.version &&
    found.url === info.url &&
    found.pid === info.pid &&
    found.password === info.password &&
    JSON.stringify(found.provenance) === JSON.stringify(info.provenance)
  yield* fs.writeFileString(temp, encoded, { mode: 0o600 }).pipe(Effect.andThen(fs.rename(temp, options.file)))
  yield* current.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("managed service registration check failed; shutting down", {
        cause,
        serviceID: options.id,
        servicePID: process.pid,
        registration: options.file,
      }).pipe(Effect.andThen(Effect.failCause(cause))),
    ),
    Effect.tap((found) =>
      owns(found)
        ? Effect.void
        : Effect.logWarning("managed service registration replaced; shutting down", {
            serviceID: options.id,
            servicePID: process.pid,
            registration: options.file,
            observedServiceID: found.id,
            observedServicePID: found.pid,
            observedVersion: found.version,
            observedURL: found.url,
          }),
    ),
    Effect.filterOrFail(owns),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.ignore,
    Effect.andThen(options.shutdown),
    Effect.forkScoped,
  )
  return current.pipe(
    Effect.flatMap((found) => (owns(found) ? fs.remove(options.file) : Effect.void)),
    Effect.ignore,
  )
})

/** Local discovery must connect to loopback, not a wildcard bind address that may go through a proxy. */
export function localURL(host: string, port: number) {
  const hostname =
    host === "0.0.0.0"
      ? "127.0.0.1"
      : host === "::" || host === "[::]"
        ? "::1"
        : host
  return `http://${hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname}:${port}`
}
