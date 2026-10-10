#!/usr/bin/env bun
import { $ } from "bun"

import { buildExtension } from "./build-extension"
import { buildCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()

await buildExtension()

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (channel === "dev") await buildCliToResources()
