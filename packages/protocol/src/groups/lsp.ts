import { Lsp } from "@opencode-ai/schema/lsp"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const LegacyLocationQuery = Schema.Struct({
  directory: Schema.String.pipe(Schema.optional),
  workspace: Schema.String.pipe(Schema.optional),
})

export const LspGroup = HttpApiGroup.make("server.lsp")
  .add(
    HttpApiEndpoint.get("lsp.status", "/lsp", {
      query: LegacyLocationQuery,
      success: Schema.Array(Lsp.Status),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "lsp.status",
        summary: "Get LSP status",
        description: "Get LSP server status.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "lsp",
      description: "Compatibility routes for language server status.",
    }),
  )
