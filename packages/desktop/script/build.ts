#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"
import { verifyBundles } from "./verify-bundles"
import { buildExtension } from "./build-extension"
import { buildCliToResources, resolveChannel } from "./utils"

// Prepare distribution assets and the development CLI before building the desktop bundle.
const dir = path.resolve(import.meta.dir, "..")

process.chdir(dir)

const channel = resolveChannel()

await buildExtension()

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

if (channel === "dev") await buildCliToResources()

await $`bunx electron-vite build`.env({ ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" })

await verifyBundles(path.join(dir, "out"))
