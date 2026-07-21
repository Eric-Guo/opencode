#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Script } from "@opencode-ai/script"
import { build, defineConfig } from "vite"
import { modelsData } from "./generate"

const dir = path.resolve(import.meta.dirname, "..")

await build(
  defineConfig({
    root: dir,
    plugins: [
      {
        name: "opencode:raw-text",
        async load(id) {
          if (!id.endsWith(".txt") && !id.endsWith(".md")) return
          return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
        },
      },
      {
        name: "opencode:wasm-file",
        enforce: "pre",
        async load(id) {
          if (!id.endsWith(".wasm")) return
          const asset = this.emitFile({
            type: "asset",
            name: path.basename(id),
            source: await readFile(id),
          })
          return `export default import.meta.ROLLUP_FILE_URL_${asset}`
        },
      },
      {
        name: "opencode:node-require",
        renderChunk(code, chunk) {
          if (!chunk.isEntry) return
          return `const require = createRequire(import.meta.url);\n${code}`
        },
      },
      {
        name: "opencode:turndown-domino",
        enforce: "pre",
        transform(code, id) {
          if (!id.endsWith("turndown/lib/turndown.es.js")) return
          const transformed = code.replace("    var domino = require('@mixmark-io/domino');", "")
          if (transformed === code) this.error("Failed to rewrite Turndown's Domino require")
          return `import domino from "@mixmark-io/domino"\n${transformed}`
        },
      },
    ],
    resolve: {
      alias: [{ find: "@", replacement: path.join(dir, "src") }],
      conditions: ["node"],
    },
    define: {
      OPENCODE_VERSION: JSON.stringify(Script.version),
      OPENCODE_MODELS_DEV: modelsData,
      OPENCODE_CHANNEL: JSON.stringify(Script.channel),
      OPENCODE_LIBC: "undefined",
      FFF_LIBC: "undefined",
      __filename: "import.meta.filename",
      __dirname: "import.meta.dirname",
    },
    ssr: { noExternal: true },
    build: {
      ssr: "src/server/server.ts",
      target: "node24",
      outDir: "dist/node",
      emptyOutDir: true,
      minify: true,
      rollupOptions: {
        external: [/^@opencode-ai\/simulation(?:\/|$)/, "node-gyp", "opencode-web-ui.gen.ts"],
        output: {
          format: "esm",
          entryFileNames: "node.js",
          manualChunks(id) {
            if (id.includes("/typescript/")) return "typescript"
          },
        },
      },
    },
  }),
)

await writeFile(path.join(dir, "dist/node/models-dev-api.json"), modelsData)
