export * as SessionError from "./session-error.js"

import { Schema } from "effect"
import { Connection } from "./connection.js"
import { IntegrationID } from "./integration-id.js"
import { NonNegativeInt, optional } from "./schema.js"

export interface ConnectionFallbackRecovery extends Schema.Schema.Type<typeof ConnectionFallbackRecovery> {}
export const ConnectionFallbackRecovery = Schema.Struct({
  type: Schema.Literal("connection-fallback"),
  integrationID: IntegrationID,
  previous: Connection.Info,
  promoted: Connection.Info,
  unavailableUntil: NonNegativeInt,
}).annotate({ identifier: "Session.Error.ConnectionFallbackRecovery" })

export const Recovery = Schema.Union([ConnectionFallbackRecovery])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Error.Recovery" })
export type Recovery = typeof Recovery.Type

export interface Error extends Schema.Schema.Type<typeof Error> {}
export const Error = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })).pipe(optional),
  recovery: Recovery.pipe(optional),
}).annotate({ identifier: "Session.StructuredError" })
