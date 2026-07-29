import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const GlobalConfig = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "GlobalConfig" })

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/global/config", {
      success: GlobalConfig,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.get",
        summary: "Get global configuration",
        description: "Retrieve global configuration required by desktop clients during migration to the current API.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config" }))
