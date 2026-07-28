#!/usr/bin/env bun
import { $ } from "bun"

import { buildCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (channel === "dev") await buildCliToResources()
await $`cd ../opencode && bun script/bundle-node.ts`
await $`cd ../7777 && bun run build`
