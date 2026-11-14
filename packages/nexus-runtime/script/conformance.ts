import { $ } from "bun"

if (!process.env.OPENCODE_NEXUS_CHROMIUM)
  throw new Error("Set OPENCODE_NEXUS_CHROMIUM to an isolated Chromium executable for browser and WebRTC conformance.")
await $`bun test test --only-failures`
