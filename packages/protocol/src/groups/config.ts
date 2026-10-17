import { Config } from "@opencode/schema/config"
import { ConfigShell } from "@opencode/schema/config/shell"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { InvalidRequestError } from "../errors.js"

export const GlobalConfig = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "GlobalConfig" })

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.shells", "/api/config/shell", {
      success: Schema.Array(ConfigShell.Option),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "config.shells",
        summary: "List available shells",
        description: "Return shells available to terminal and agent execution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("config.update", "/api/experimental/config", {
      query: Schema.Struct({ ...LocationQuery.fields, target: Schema.optional(Config.UpdateTarget) }),
      payload: Config.Patch,
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.config.update",
        summary: "Update global configuration",
        description:
          "Patch supported fields while preserving JSONC. Defaults to the highest-precedence global document; target=user writes the standard user opencode.jsonc. Returns after configuration has reloaded.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("config.global", "/global/config", {
      success: GlobalConfig,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.global",
        summary: "Get global configuration",
        description: "Retrieve global configuration required by desktop clients during migration to the current API.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Configuration routes." }))
