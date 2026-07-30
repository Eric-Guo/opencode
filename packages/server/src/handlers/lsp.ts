import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LspHandler = HttpApiBuilder.group(Api, "server.lsp", (handlers) =>
  handlers.handle("lsp.status", () =>
    // V2 does not run language servers yet, so no active server statuses can be reported.
    Effect.succeed([]),
  ),
)
