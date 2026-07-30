import { $ } from "bun"
import { cp, mkdir, rm } from "node:fs/promises"
import { buildEmbeddedSidecar } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await buildEmbeddedSidecar()
await $`cd ../7777 && bun run build`
await rm("out/renderer/7777", { recursive: true, force: true })
await mkdir("out/renderer", { recursive: true })
await cp("../7777/dist", "out/renderer/7777", { recursive: true })
