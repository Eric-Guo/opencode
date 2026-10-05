import { mkdir, realpath, writeFile, appendFile } from "node:fs/promises"
import path from "node:path"

// Foreground, fake-provider acceptance host. Never inherits account credentials.
const root = process.argv[2]
if (!root || !path.isAbsolute(root) || path.resolve(root) !== root)
  throw new Error("Provide a fresh absolute fixture directory")
if ((await realpath(path.dirname(root))) !== path.dirname(root)) throw new Error("Fixture parent must be canonical")
await mkdir(root, { mode: 0o700 })
for (const name of ["home", "project", "config", "data", "cache", "state"])
  await mkdir(path.join(root, name), { mode: 0o700 })
const metrics = { requests: 0, active: 0, maxActive: 0 }
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("not found", { status: 404 })
    const body = await request.text()
    metrics.requests++
    metrics.active++
    metrics.maxActive = Math.max(metrics.maxActive, metrics.active)
    await writeFile(path.join(root, "fake-provider-metrics.json"), JSON.stringify(metrics), { mode: 0o600 })
    if (body.includes("slow:")) await Bun.sleep(10_000)
    metrics.active--
    await writeFile(path.join(root, "fake-provider-metrics.json"), JSON.stringify(metrics), { mode: 0o600 })
    const chunks = [
      { choices: [{ delta: { role: "assistant", content: "fake workspace-sharing hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
await writeFile(
  path.join(root, "config", "opencode.json"),
  JSON.stringify({
    update: "disable",
    model: "test/test-model",
    providers: {
      test: {
        name: "Test",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "fake-test-key", baseURL: `http://127.0.0.1:${llm.port}/v1` },
        models: {
          "test-model": {
            name: "Test",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 1000 },
          },
        },
      },
    },
  }),
  { mode: 0o600 },
)
await writeFile(path.join(root, "models.json"), "{}", { mode: 0o600 })
const env = {
  PATH: "/usr/bin:/bin",
  HOME: path.join(root, "home"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_DB: path.join(root, "opencode.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_MODELS_PATH: path.join(root, "models.json"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_FFF: "1",
  OPENCODE_FILEWATCHER_DISABLE: "1",
}
const server = Bun.spawn(
  [
    process.execPath,
    path.resolve(import.meta.dir, "../src/index.ts"),
    "serve",
    "--workspace-sharing",
    path.join(root, "spool"),
  ],
  { cwd: path.join(root, "project"), env, stdout: "pipe", stderr: "pipe" },
)
const state = { stopping: false, ready: false }
const output = async (stream: ReadableStream<Uint8Array>, filename: string) => {
  const reader = stream.getReader()
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return
      const text = new TextDecoder().decode(part.value)
      await appendFile(path.join(root, filename), text, { mode: 0o600 })
      if (text.includes("workspace sharing ready")) state.ready = true
    }
  } finally {
    reader.releaseLock()
  }
}
const streams = [output(server.stdout, "server.log"), output(server.stderr, "server-error.log")]
const stop = () => {
  state.stopping = true
  if (server.exitCode === null) server.kill("SIGINT")
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
const lifetime = setTimeout(stop, 600_000)
const readyDeadline = Date.now() + 30_000
while (!state.ready && !state.stopping && server.exitCode === null && Date.now() < readyDeadline) await Bun.sleep(50)
if (state.ready)
  console.log("Ready. Formal CLI + fake model, concurrency 2. Auto-stops after 10 minutes; Ctrl+C also stops it.")
if (!state.ready) {
  console.error("Fixture did not become ready; inspect its private server logs.")
  stop()
}
while (!state.stopping && server.exitCode === null) await Bun.sleep(100)
stop()
const kill = setTimeout(() => {
  if (server.exitCode === null) server.kill("SIGKILL")
}, 10_000)
await server.exited
clearTimeout(kill)
clearTimeout(lifetime)
await Promise.all(streams)
await llm.stop(true)
console.log("Stopped. Formal test service and fake provider closed.")
