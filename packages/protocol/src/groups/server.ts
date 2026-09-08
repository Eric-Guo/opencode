import { MyTodo } from "@opencode/schema/my-todo"
import { ServiceUnavailableError } from "../errors.js"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const ServerGroup = HttpApiGroup.make("server.server")
  .add(
    HttpApiEndpoint.get("server.get", "/api/server", {
      success: Schema.Struct({ urls: Schema.Array(Schema.String) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.server.get",
        summary: "Get server information",
        description: "Return the URLs that can be used to connect to this server.",
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
  .add(
    HttpApiEndpoint.get("server.myTodoSelection", "/api/server/my-todo/selection", {
      success: Schema.NullOr(MyTodo.Project),
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.server.myTodoSelection", summary: "Get the saved work project" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("server.selectMyTodo", "/api/server/my-todo/selection", {
      payload: MyTodo.Project,
      success: MyTodo.Project,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.server.selectMyTodo", summary: "Save the selected work project" }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "server" }))
