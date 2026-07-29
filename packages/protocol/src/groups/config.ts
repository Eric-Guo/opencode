import { Config } from "@opencode-ai/schema/config"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

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
          identifier: "v2.config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
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
