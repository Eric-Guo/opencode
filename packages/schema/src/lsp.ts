export * as Lsp from "./lsp.js"

import { Schema } from "effect"

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "Lsp.Status" })
