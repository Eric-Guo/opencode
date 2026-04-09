import "./plugin-runtime.promise"
import "./plugin-runtime.effect"
import http from "node:http"

try {
  // Node 26 has a newer API than the current @types/node package.
  const proxyAwareHttp = http as typeof http & { setGlobalProxyFromEnv(): void }
  proxyAwareHttp.setGlobalProxyFromEnv()
} catch (error) {
  console.warn("Failed to load proxy environment", error)
}

process.stdout.on("error", (error) => {
  if ("code" in error && error.code === "EPIPE") return
  throw error
})

await import("../index")
