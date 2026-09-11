#!/usr/bin/env bun
import { $ } from "bun"

import { buildEmbeddedSidecar, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await buildEmbeddedSidecar()
await $`cd ../7777 && bun run build`
