import { query } from "@solidjs/router"
import { loadModelCatalog } from "../routes/model-catalog"

export const getModelCatalog = query(async () => {
  "use server"
  return loadModelCatalog()
}, "getModelCatalog")
