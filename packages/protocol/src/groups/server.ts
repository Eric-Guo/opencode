import { MyTodo } from "@opencode/schema/my-todo"
import { ServiceUnavailableError } from "../errors.js"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const ServerInfo = Schema.Struct({
  version: Schema.String,
  // 0 means the runtime has no OS process identity (e.g. workerd).
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  urls: Schema.Array(Schema.String),
  paths: Schema.Struct({
    tmp: Schema.String,
  }),
}).annotate({ identifier: "ServerInfo" })
export type ServerInfo = typeof ServerInfo.Type

export const ServerGroup = HttpApiGroup.make("server.server")
  .add(
    HttpApiEndpoint.get("server.info", "/api/info", {
      success: ServerInfo,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.info",
        summary: "Get server info",
        description: "Return the server identity, connection URLs, paths, and readiness status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("server.myTodoProjects", "/api/server/my-todo/projects", {
      success: Schema.Array(MyTodo.Project),
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.server.myTodoProjects", summary: "Refresh PLM work projects" }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "server" }))
