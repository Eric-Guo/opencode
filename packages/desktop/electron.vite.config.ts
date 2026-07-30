import { defineConfig } from "electron-vite"
import { cp, rm } from "node:fs/promises"

const OPENCODE_SERVER_DIST = "../cli/dist-node"
const SEVEN_SEVEN_DIST = "../7777/dist"
const SEVEN_SEVEN_RENDERER_OUT = "./out/renderer/7777"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "local" || raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = (() => {
  if (process.env.RUST_TARGET === "aarch64-apple-darwin") return "@lydell/node-pty-darwin-arm64"
  if (process.env.RUST_TARGET === "x86_64-apple-darwin") return "@lydell/node-pty-darwin-x64"
  if (process.env.RUST_TARGET === "aarch64-pc-windows-msvc") return "@lydell/node-pty-win32-arm64"
  if (process.env.RUST_TARGET === "x86_64-pc-windows-msvc") return "@lydell/node-pty-win32-x64"
  if (process.env.RUST_TARGET === "aarch64-unknown-linux-gnu") return "@lydell/node-pty-linux-arm64"
  if (process.env.RUST_TARGET === "x86_64-unknown-linux-gnu") return "@lydell/node-pty-linux-x64"
  return `@lydell/node-pty-${process.platform}-${process.arch}`
})()

const appPlugin = (await import("@opencode-ai/app/vite")).default
const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? (await import("@sentry/vite-plugin")).sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rolldownOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while an output banner places the shim safely.
        output: {
          format: "es",
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { exclude: ["@opencode-ai/core"], include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
          return undefined
        },
      },
      {
        name: "opencode:copy-server-dist",
        async writeBundle() {
          await cp(`${OPENCODE_SERVER_DIST}/sidecar.mjs`, "./out/main/chunks/sidecar.mjs", { force: true })
          await cp(`${OPENCODE_SERVER_DIST}/assets`, "./out/main/chunks/assets", { recursive: true, force: true })
        },
      },
    ],
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    experimental: {
      bundledDev: true,
    },
    define: {
      "import.meta.env.OPENCODE_VERSION": JSON.stringify(process.env.OPENCODE_VERSION),
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    plugins: [
      appPlugin,
      {
        name: "opencode:copy-7777-renderer",
        apply: "build",
        async writeBundle() {
          await rm(SEVEN_SEVEN_RENDERER_OUT, { recursive: true, force: true })
          await cp(SEVEN_SEVEN_DIST, SEVEN_SEVEN_RENDERER_OUT, { recursive: true })
        },
      },
      sentry,
    ],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rolldownOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
