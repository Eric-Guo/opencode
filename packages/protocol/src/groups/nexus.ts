import { NexusCommand, NexusOperator } from "../nexus-command.js"
import { Nexus } from "@opencode/schema/nexus"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"

const Setup = Schema.Struct({
  origin: Schema.String,
  model: Schema.String,
  workspace: Schema.String,
  directory: Schema.String,
})
const Status = Schema.Struct({
  ...Setup.fields,
  state: Schema.Literals(["unpaired", "pairing", "connecting", "ready", "error"]),
  identity: Schema.optional(
    Schema.Struct({
      agent: Schema.String,
      name: Schema.String,
      runner: Schema.String,
      workspace: Schema.String,
      workspaceName: Schema.String,
    }),
  ),
  pairing: Schema.optional(Schema.Struct({ code: Schema.String, url: Schema.String })),
  error: Schema.optional(Schema.String),
})
const error = [ForbiddenError, InvalidRequestError, ServiceUnavailableError]
const annotations = (name: string, summary: string) =>
  OpenApi.annotations({
    identifier: "experimental.nexus." + name,
    summary,
    description: "Experimental: may change without compatibility guarantees.",
  })

export const NexusGroup = HttpApiGroup.make("server.nexus").add(
  HttpApiEndpoint.get("nexus.extensions", "/api/experimental/nexus/extensions", {
    success: Schema.Array(Nexus.Extension),
    error,
  }).annotateMerge(annotations("extensions", "Inspect Nexus extension configuration and readiness")),
  HttpApiEndpoint.patch("nexus.configureExtension", "/api/experimental/nexus/extensions/configuration", {
    payload: Nexus.ExtensionChange,
    success: Nexus.ConfigurationResult,
    error,
  }).annotateMerge(annotations("configureExtension", "Save Nexus extension configuration and schedule activation")),
  HttpApiEndpoint.get("nexus.status", "/api/experimental/nexus/status", { success: Status, error }).annotateMerge(
    annotations("status", "Get the Nexus connection"),
  ),
  HttpApiEndpoint.post("nexus.pair", "/api/experimental/nexus/pair", {
    payload: Setup,
    success: Status,
    error,
  }).annotateMerge(annotations("pair", "Pair this installation with Nexus")),
  HttpApiEndpoint.post("nexus.disconnect", "/api/experimental/nexus/disconnect", {
    success: Status,
    error,
  }).annotateMerge(annotations("disconnect", "Disconnect this installation from Nexus")),
  HttpApiEndpoint.post("nexus.login", "/api/experimental/nexus/login", {
    success: Schema.Struct({ url: Schema.String }),
    error,
  }).annotateMerge(annotations("login", "Start Human Nexus sign-in with PKCE")),
  HttpApiEndpoint.get("nexus.account", "/api/experimental/nexus/account", {
    success: Schema.NullOr(Schema.Struct({ id: Schema.String, role: Schema.String })),
    error,
  }).annotateMerge(annotations("account", "Read the signed-in Nexus account")),
  HttpApiEndpoint.post("nexus.logout", "/api/experimental/nexus/logout", { success: Schema.Void, error }).annotateMerge(
    annotations("logout", "Sign out of the Nexus platform"),
  ),
  HttpApiEndpoint.post("nexus.operator", "/api/experimental/nexus/operator", {
    payload: NexusOperator,
    success: Schema.Struct({ upload: Schema.NullOr(Schema.String) }),
    error,
  }).annotateMerge(annotations("operator", "Download a conversation runner file or restore a recorded local change")),
  HttpApiEndpoint.post("nexus.manage", "/api/experimental/nexus/manage", {
    payload: NexusCommand,
    headers: Schema.Struct({
      "x-nexus-origin": Schema.optional(Schema.String),
      "x-nexus-member-token": Schema.optional(Schema.String),
    }),
    success: Schema.Json,
    error,
  }).annotateMerge(annotations("manage", "Manage Nexus schedules and memory documents")),
  HttpApiEndpoint.get("nexus.catalog", "/api/experimental/nexus/catalog", {
    query: Schema.Struct({
      kind: Schema.Literals(["schedules", "memory", "mcp"]),
      after: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          state: Schema.String,
          detail: Schema.NullOr(Schema.String),
        }),
      ),
      next: Schema.NullOr(Schema.String),
    }),
    error,
  }).annotateMerge(annotations("catalog", "Inspect workspace schedules, memory collections or agent MCP connections")),
  HttpApiEndpoint.get("nexus.runners", "/api/experimental/nexus/runners", {
    success: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    error,
  }).annotateMerge(annotations("runners", "List eligible Nexus runners")),
  HttpApiEndpoint.post("nexus.modes", "/api/experimental/nexus/modes", {
    payload: Schema.Struct({
      workspace: Schema.String,
      conversation: Schema.String,
      patch: Schema.optional(
        Schema.Struct({ code_mode: Schema.optional(Schema.Boolean), subagent: Schema.optional(Schema.Boolean) }),
      ),
    }),
    success: Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean }),
    error,
  }).annotateMerge(annotations("modes", "Read or update conversation tool choices")),
  HttpApiEndpoint.post("nexus.grant", "/api/experimental/nexus/grant", {
    payload: Schema.Struct({
      workspace: Schema.String,
      conversation: Schema.String,
      run: Schema.String,
      task: Schema.String,
    }),
    success: Schema.Void,
    error,
  }).annotateMerge(annotations("grant", "Remember the approved web fetch site until the service restarts")),
  HttpApiEndpoint.post("nexus.policy", "/api/experimental/nexus/policy", {
    payload: Schema.Struct({ workspace: Schema.String, conversation: Schema.String }),
    success: Schema.Struct({
      tools: Schema.Array(Schema.String),
      directory: Schema.NullOr(Schema.String),
      runner: Schema.NullOr(Schema.String),
    }),
    error,
  }).annotateMerge(annotations("policy", "Prepare this conversation's runner tools")),
)
