import { sentryVitePlugin } from "@sentry/vite-plugin"
import { resolve } from "node:path"
import { defineConfig, normalizePath } from "vite"
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

export default defineConfig({
  plugins: [desktopPlugin, icons(channel), serviceWorker(outDir), sentry],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    outDir,
    rolldownOptions:
      process.env.VITE_OPENCODE_TEST_FIXTURES === "1"
        ? {
            input: [
              "index.html",
              "e2e/utils/settings-wsl.html",
              "e2e/utils/app-direction.html",
              "e2e/utils/windows-menu.html",
            ],
          }
        : undefined,
    assetsDir: "_assets",
    target: "esnext",
    sourcemap: true,
  },
})
