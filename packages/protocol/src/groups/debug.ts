import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Tool } from "@opencode-ai/schema/tool"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { AgentNotFoundError, ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const ToolParams = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "AgentToolParams" })
const ToolResult = Schema.Struct({
  output: Schema.Json.pipe(Schema.optional),
  content: Schema.Array(Tool.Content),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}).annotate({ identifier: "AgentToolResult" })

export const DebugGroup = HttpApiGroup.make("server.debug")
  .add(
    HttpApiEndpoint.get("debug.location", "/api/debug/location", {
      success: Schema.Array(Location.Ref),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.debug.location.list",
        summary: "List loaded locations",
        description: "List locations currently loaded by the server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("debug.location.evict", "/api/debug/location", {
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.debug.location.evict",
          summary: "Evict a loaded location",
          description: "Dispose the requested location's cached services so its next use boots them fresh.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("debug.agent.tools", "/api/debug/agent/:agentID/tool", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, Schema.Boolean)),
      error: [AgentNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.debug.agent.tools",
          summary: "List agent tools",
          description: "List registered tools and whether each tool is enabled for the agent.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("debug.agent.executeTool", "/api/debug/agent/:agentID/tool/:toolID", {
      params: { agentID: Agent.ID, toolID: Schema.String },
      query: LocationQuery,
      payload: ToolParams,
      success: Location.response(ToolResult),
      error: [AgentNotFoundError, ForbiddenError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.debug.agent.executeTool",
          summary: "Execute an agent tool",
          description: "Execute a registered tool in a debug session using the agent's permissions.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "debug" }))
