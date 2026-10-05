import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const cli = path.resolve(import.meta.dir, "../../src/index.ts")

test("real CLI keeps the service DB unique and reuses run with stable IDs", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-integration-")))
  const project = path.join(root, "project")
  const config = path.join(root, "config")
  await mkdir(project)
  await mkdir(config)
  const received: string[] = []
  const llm = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = await request.text()
      received.push(body)
      const chunks = [
        { choices: [{ delta: { role: "assistant", content: "fake integration hello" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await writeFile(
    path.join(config, "opencode.json"),
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
  )
  await writeFile(path.join(root, "models.json"), "{}")
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_PASSWORD: "fake-local-service-password",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: path.join(root, "models.json"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
  }
  const spool = path.join(root, "spool")
  const server = Bun.spawn([process.execPath, cli, "serve", "--workspace-sharing", spool], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(server.stderr).text()
  const reader = server.stdout.getReader()
  const logs = { stdout: "" }
  const output = (async () => {
    while (true) {
      const part = await reader.read()
      if (part.done) return
      logs.stdout += new TextDecoder().decode(part.value)
    }
  })()
  const invoke = async (args: string[], input = "") => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: project,
      env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, error, code }
  }
  try {
    const deadline = Date.now() + 30_000
    while (!logs.stdout.includes("workspace sharing ready") && server.exitCode === null && Date.now() < deadline)
      await Bun.sleep(50)
    if (!logs.stdout.includes("workspace sharing ready"))
      throw new Error(
        `Owner did not start: ${logs.stdout}; ${server.exitCode === null ? "still running" : await stderr}`,
      )
    const run = await invoke(
      ["run", "--workspace-sharing", spool, "--request-id", "real-cli-one", "--format", "json"],
      "hello",
    )
    expect(run.code, run.error).toBe(0)
    expect(run.stdout).toContain("fake integration hello")
    const status = await invoke(["task", "status", "real-cli-one", "--workspace-sharing", spool])
    expect(status.code, status.error).toBe(0)
    const task = JSON.parse(status.stdout)
    expect(task.state).toBe("completed")
    expect(task.starts).toBe(1)
    const callsBeforeRetry = received.length
    const duplicate = await invoke(
      ["run", "--workspace-sharing", spool, "--request-id", "real-cli-one", "--format", "json"],
      "hello",
    )
    expect(duplicate.code, duplicate.error).toBe(0)
    expect(received).toHaveLength(callsBeforeRetry)
    expect(received.some((body) => body.includes("hello"))).toBe(true)
    const history = await invoke(["session", "list", "--workspace-sharing", spool, "--format", "json"])
    expect(history.code, history.error).toBe(0)
    expect(JSON.parse(history.stdout).map((item: { id: string }) => item.id)).toContain(task.sessionID)
    const mixed = await invoke(["run", "--workspace-sharing", spool, "--standalone"], "hello")
    expect(mixed.code).not.toBe(0)
    expect(mixed.error).toContain("cannot be combined")
    expect((await readdir(root, { recursive: true })).filter((name) => /\.(db|sqlite)$/.test(name))).toEqual([
      "opencode.db",
    ])
    const url = logs.stdout.match(/server listening on (http:\/\/[^\s]+)/)?.[1]
    expect(url).toBeString()
    const legacy = await invoke(["run", "--server", url!, "--format", "json"], "legacy hello")
    expect(legacy.code, legacy.error).toBe(0)
    expect(legacy.stdout).toContain("fake integration hello")
    const empty = await invoke(["serve", "--workspace-sharing", ""])
    expect(empty.code).not.toBe(0)
    expect(empty.error).toContain("nonempty absolute directory")
  } finally {
    if (server.exitCode === null) server.kill("SIGINT")
    const timer = setTimeout(() => {
      if (server.exitCode === null) server.kill("SIGKILL")
    }, 10_000)
    await server.exited
    clearTimeout(timer)
    await output
    reader.releaseLock()
    await llm.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
