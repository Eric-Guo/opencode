import { provenance } from "../../src/service-provenance"

await provenance().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
