import { sentryVitePlugin } from "@sentry/vite-plugin"
import { resolve } from "node:path"
import { defineConfig, normalizePath, type Plugin, type UserConfig } from "vite"
import desktopPlugin, { channel } from "./vite.js"
import { icons } from "./vite.icons"
import { serviceWorker } from "./vite.pwa"

const outDir = normalizePath(resolve(import.meta.dirname, process.env.OPENCODE_APP_OUTDIR ?? "dist"))

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: `${outDir}/**`,
          filesToDeleteAfterUpload: `${outDir}/**/*.map`,
        },
      })
    : false

// The app is built for the root by default; `vite build --base=/opencode/` serves it under that path. A base without
// its trailing slash would reach `import.meta.env.BASE_URL` and `%BASE_URL%` as is and glue paths onto it.
const basePath: Plugin = {
  name: "opencode-app:base-path",
  config(config) {
    if (config.base?.startsWith("/") && !config.base.endsWith("/")) return { base: `${config.base}/` }
  },
}

// The e2e build also emits the fixture pages the tests open beside the app.
const testFixtureInput = [
  "index.html",
  "e2e/utils/settings-wsl.html",
  "e2e/utils/app-direction.html",
  "e2e/utils/windows-menu.html",
]

const build: UserConfig["build"] = { outDir, assetsDir: "_assets", target: "esnext", sourcemap: true }

if (process.env.VITE_OPENCODE_TEST_FIXTURES === "1") build.rolldownOptions = { input: testFixtureInput }

export default defineConfig({
  plugins: [basePath, desktopPlugin, icons(channel), serviceWorker(outDir), sentry],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build,
})
