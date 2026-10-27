#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"
import { buildExtension } from "./build-extension"
import { buildCliToResources, resolveChannel } from "./utils"

// Prepare distribution assets and the development CLI before building the desktop bundle.
process.chdir(path.resolve(import.meta.dir, ".."))

if (
  process.env.OPENCODE_DESKTOP_EXTENSION === undefined &&
  (await Bun.file("../desktop-tab/desktop-extension.json").exists())
) {
  process.env.OPENCODE_DESKTOP_EXTENSION = "../desktop-tab"
}

const channel = resolveChannel()

await buildExtension()

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

if (channel === "dev") await buildCliToResources()

await $`bunx electron-vite build`.env({ ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" })
