import { defineConfig, type UserConfig } from "vite"
import { Installation } from "@opencode-ai/core/installation"
import { nodeTarget } from "./src/node/target"
import {
  nodePrelude,
  output,
  rawTextPlugin,
  resolve,
  runtimeRequirePlugin,
  type NodeBuildInput,
} from "./vite.node.config"

export function sidecarConfig(input: NodeBuildInput): UserConfig {
  return defineConfig({
    root: import.meta.dirname,
    plugins: [rawTextPlugin(), runtimeRequirePlugin()],
    resolve,
    define: {
      OPENCODE_VERSION: JSON.stringify(input.version),
      OPENCODE_CLI_NAME: JSON.stringify("opencode2-node"),
      OPENCODE_MODELS_DEV: input.models,
      OPENCODE_CHANNEL: JSON.stringify(input.channel),
      OPENCODE_LIBC: input.target.platform === "linux" ? JSON.stringify("glibc") : "undefined",
      FFF_LIBC: input.target.platform === "linux" ? JSON.stringify("gnu") : "undefined",
    },
    ssr: { noExternal: true },
    build: {
      ssr: "src/node/sidecar.ts",
      target: "node26",
      outDir: "dist-node",
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        external: [/^@opencode-ai\/simulation(?:\/|$)/],
        output: output("sidecar.mjs", nodePrelude(input)),
      },
    },
  })
}

export default sidecarConfig({
  version: process.env.OPENCODE_VERSION ?? Installation.version,
  channel: process.env.OPENCODE_CHANNEL ?? "local",
  models: "undefined",
  assetHash: "local",
  target: nodeTarget(process.platform, process.arch),
})
