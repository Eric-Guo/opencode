export * as NexusAcp from "./nexus-acp.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["acp.list", "acp.sessions"]) }),
  Schema.Struct({
    action: Schema.Literal("acp.probe"),
    agent: Schema.NonEmptyString,
    workdir: Schema.String.pipe(optional),
  }),
  Schema.Struct({ action: Schema.Literals(["acp.kill", "acp.logs"]), session: Schema.NonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("acp.release"),
    workspace: Schema.NonEmptyString,
    conversation: Schema.NonEmptyString,
  }),
])
export type Command = typeof Command.Type
