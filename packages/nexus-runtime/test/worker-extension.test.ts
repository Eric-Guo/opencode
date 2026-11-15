import { expect, test } from "bun:test"
import { symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { definition, type RunnerContext } from "../src/extensions"
import { workerRegistration } from "../src/worker-extension"
import { RunnerInbox } from "../src/runner-inbox"
import { RunnerAdmission } from "../src/runner"
import { executorFixture } from "./fixture/executor"

const descriptor = {
  id: "fixture.worker",
  name: "Worker",
  description: "An isolated extension fixture.",
  configuration_version: 1,
  configuration_schema: { type: "object", additionalProperties: false } as const,
  defaults: {},
  default_enabled: true,
}

test("the minified Node loader transforms external TypeScript and preserves SDK errors and shutdown", async () => {
  await using directory = await tmpdir()
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(directory.path, "node_modules"),
    "junction",
  )
  await writeFile(join(directory.path, "package.json"), JSON.stringify({ type: "module" }))
  await writeFile(
    join(directory.path, "helper.ts"),
    `
    export enum Answer { Value = 42 }
    export class Box { constructor(readonly value: number) {} }
  `,
  )
  await writeFile(
    join(directory.path, "extension.ts"),
    `
    import { NotFound } from "@cybros/agent"
    import { Answer, Box } from "./helper.js"
    export function register(api) {
      api.restartOnly()
      api.describeStatus(() => ({ ready: true, issues: [] }))
      api.registerCommand("check", async () => {
        let missing = false
        try { await api.application().missing() }
        catch (error) { missing = error instanceof NotFound }
        return { value: new Box(Answer.Value).value, missing, configured: api.configuration.marker }
      })
      api.onShutdown(() => api.application().closed())
    }
  `,
  )
  await writeFile(
    join(directory.path, "smoke.mjs"),
    `
    import assert from "node:assert/strict"
    import { NotFound } from "@cybros/agent"
    import { fileURLToPath } from "node:url"
    import { workerRegistration } from "./dist/worker-extension.js"
    const commands = new Map()
    const closures = []
    let closed = false
    let restartOnly = false
    await workerRegistration(fileURLToPath(new URL("./extension.ts", import.meta.url)))({
      directory: process.cwd(), signal: new AbortController().signal,
      configuration: { marker: "node-production" },
      application: () => ({ missing() { return Promise.reject(new NotFound("missing")) }, closed() { closed = true } }),
      configure() { throw new Error("unused") },
      restartOnly() { restartOnly = true },
      registerCommand(name, handler) { commands.set(name, handler) },
      registerTool() {}, registerDocument() {}, on() {}, onToolResult() {}, describeStatus() {}, describeEnvironment() {},
      onShutdown(callback) { closures.push(callback) },
    })
    try {
      assert.equal(restartOnly, true)
      assert.deepEqual(await commands.get("check")({}), { value: 42, missing: true, configured: "node-production" })
    } finally {
      for (const close of closures) await close()
    }
    assert.equal(closed, true)
    console.log("Node worker passed")
  `,
  )
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/worker-extension.ts", import.meta.url))],
    outdir: join(directory.path, "dist"),
    target: "node",
    format: "esm",
    packages: "external",
    minify: true,
  })
  expect(build.success).toBe(true)
  await using child = Bun.spawn(["node", join(directory.path, "smoke.mjs")], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).not.toContain("Error:")
  expect(code).toBe(0)
  expect(stdout).toContain("Node worker passed")
})

test("a blocked synchronous handler is terminated, releases ownership, and reloads one replacement", async () => {
  await using directory = await tmpdir()
  const path = join(directory.path, "extension.ts")
  await writeFile(
    path,
    `
    const generation = crypto.randomUUID();
    export function register(api) {
      api.describeStatus(() => ({ ready: true, issues: [] }));
      api.registerCommand("generation", async () => generation);
      api.registerTool({
        definition: ${JSON.stringify(definition("worker", "Worker", {}, []))},
        execute(input, context) {
          if (input.wait) return context.ask("wait", "waiting").then(content => ({ content }));
          if (input.block) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          return Promise.resolve({content: generation});
        }
      });
    }
  `,
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory.path, "settings.json")),
    [{ descriptor, register: workerRegistration(path, { cancellationGraceMs: 20 }) }],
    directory.path,
    new AbortController().signal,
    async () => {},
  )
  const owner = new AbortController()
  const sibling = new AbortController()
  const begun = Promise.withResolvers<void>()
  const yielded = Promise.withResolvers<void>()
  const context: RunnerContext = {
    workspace: "workspace",
    conversation: "conversation",
    run: "run",
    task: "block",
    directory: directory.path,
    signal: owner.signal,
    executionStarted: begun.resolve,
    started() {
      throw new Error("The synchronous prefix has not returned.")
    },
  }
  try {
    await manager.start()
    expect(manager.list()[0]).toMatchObject({ active: true, ready: true })
    const generation = await manager.command("generation", {})
    const waiting = manager
      .tools()[0]
      .execute(
        { wait: true },
        {
          ...context,
          signal: sibling.signal,
          executionStarted: undefined,
          started: yielded.resolve,
          workerRetired: (reason) => sibling.abort(reason),
          ask: () =>
            new Promise((_resolve, reject) =>
              sibling.signal.addEventListener("abort", () => reject(sibling.signal.reason), { once: true }),
            ),
        },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await yielded.promise
    const running = manager.tools()[0].execute({ block: true }, context)
    const outcome = running.then(
      () => undefined,
      (error: unknown) => error,
    )
    await begun.promise
    owner.abort(new Error("Canceled by the caller."))
    expect(await outcome).toBeInstanceOf(Error)
    expect(await waiting).toBeInstanceOf(Error)
    expect(sibling.signal.aborted).toBe(true)
    const replacements = await Promise.all([manager.command("generation", {}), manager.command("generation", {})])
    expect(replacements[0]).not.toBe(generation)
    expect(replacements[0]).toBe(replacements[1])
    expect(
      (await manager.tools()[0].execute({}, { ...context, signal: new AbortController().signal, started: undefined }))
        .content,
    ).toBe(String(replacements[0]))
  } finally {
    owner.abort()
    sibling.abort()
    await manager.close()
  }
})

test("a blocked worker keeps startup capacity until cancellation while other inbox work stays responsive", async () => {
  const fixture = await executorFixture()
  const path = join(fixture.directory, "extension.ts")
  const blocked = Promise.withResolvers<void>()
  const healthy = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  await writeFile(
    path,
    `
    export function register(api) {
      api.registerTool({
        definition: ${JSON.stringify(definition("block", "Blocking worker", {}, []))},
        resource: { name: "device", concurrency: 1 },
        execute(input, context) {
          context.progress("blocked");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          return Promise.resolve({content: "unreachable"});
        }
      });
    }
  `,
  )
  const manager = new ExtensionManager(
    new Configuration(join(fixture.directory, "settings.json")),
    [{ descriptor, register: workerRegistration(path, { cancellationGraceMs: 20 }) }],
    fixture.directory,
    new AbortController().signal,
    async () => {},
  )
  const admission = new RunnerAdmission(() => released.resolve())
  const runner = new RunnerInbox({
    executor: fixture.client,
    id: "executor",
    root: fixture.directory,
    journal: fixture.journal,
    signal: new AbortController().signal,
    startupLimit: 2,
    admission,
    wake() {},
    extensions: () => [
      ...manager.tools(),
      {
        definition: definition("healthy", "Healthy", {}, []),
        async execute() {
          return { content: "healthy" }
        },
      },
    ],
  })
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/progress")) return
    blocked.resolve()
    return new Response(null, { status: 202 })
  }
  fixture.control.committed = (_run, task) => {
    if (task === "healthy") healthy.resolve()
  }
  fixture.add("run", "blocked", "block")
  fixture.add("run", "healthy", "healthy")
  const notify = (task: string, tool: string) =>
    runner.notify({
      event: {
        type: "work_available",
        kind: "tool_call",
        role: "runner",
        run_public_id: "run",
        task_key: task,
        tool_name: tool,
      },
    })
  try {
    await manager.start()
    notify("blocked", "block")
    await blocked.promise
    expect(runner.snapshot().starting).toBe(1)
    expect(admission.reserve(manager.tools()[0])).toBeUndefined()
    notify("healthy", "healthy")
    await healthy.promise
    expect(runner.snapshot().starting).toBe(1)
    runner.notify({ event: { type: "work_canceled", run_public_id: "run", task_key: "blocked" } })
    await runner.drain()
    await released.promise
    const permit = admission.reserve(manager.tools()[0])
    expect(permit).toBeFunction()
    permit?.()
    expect(fixture.commits.filter((row) => row.task === "blocked")).toHaveLength(1)
    expect(fixture.commits.find((row) => row.task === "blocked")?.body).toMatchObject({ outcome: "failed" })
  } finally {
    await runner.close()
    await manager.close()
    await fixture.close()
  }
})

test("initial status is covered by the registration deadline", async () => {
  await using directory = await tmpdir()
  const path = join(directory.path, "extension.ts")
  await writeFile(
    path,
    `export function register(api) {
    api.describeStatus(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
  }`,
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory.path, "settings.json")),
    [{ descriptor, register: workerRegistration(path, { startupMs: 100, cancellationGraceMs: 20 }) }],
    directory.path,
    new AbortController().signal,
    async () => {},
  )
  try {
    await manager.start()
    expect(manager.list()[0]).toMatchObject({ active: false, ready: false })
    expect(manager.list()[0].diagnostics.join(" ")).toContain("timed out")
  } finally {
    await manager.close()
  }
})

test("worker registrations carry typed tool hooks, startup, commands and agent contributions", async () => {
  await using directory = await tmpdir()
  const entry = join(directory.path, "extension.ts")
  await writeFile(
    entry,
    `
    let started = false;
    export function register(api) {
      api.onStartup(() => { started = true });
      api.background("poller", signal => new Promise(resolve => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      }));
      api.registerConversationServers(async () => ({ tools: [], issues: [], close: async () => {} }));
      api.registerAgent({ name: "worker-room", description: "Worker room", system_prompt: "Help", configuration: {} });
      api.registerCommand("worker.echo", async input => ({ ...input, started }), { description: "Echo", input_schema: { type: "object" } });
      api.on("experimental.tool.call", call => ({ rewrite: { text: call.context.task } }));
      api.on("experimental.tool.result", call => ({ ...call.result, content: call.input.text + ":worker" }));
    }
  `,
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory.path, "settings.json")),
    [
      {
        descriptor,
        register: workerRegistration(entry),
      },
    ],
    directory.path,
    new AbortController().signal,
    async () => {},
  )
  try {
    await manager.start()
    expect(manager.list()[0].ready).toBe(true)
    expect(await manager.command("worker.echo", { value: 42 })).toEqual({ value: 42, started: true })
    expect(manager.agents().map((agent) => agent.name)).toEqual(["worker-room"])
    const servers = await manager.conversationServers()!({
      workspace: "w",
      conversation: "c",
      directory: directory.path,
      servers: [],
      signal: new AbortController().signal,
    })
    expect(servers.tools).toEqual([])
    await servers.close()
    const hooks = manager.captureTools()
    const call = {
      tool: definition("probe", "Probe", {}, []),
      input: {},
      context: {
        directory: directory.path,
        workspace: "w",
        conversation: "c",
        run: "r",
        task: "task",
        signal: new AbortController().signal,
      },
    }
    try {
      expect(await hooks.before(call)).toEqual({ input: { text: "task" } })
      expect(await hooks.after({ ...call, input: { text: "task" }, result: { content: "original" } })).toEqual({
        content: "task:worker",
      })
    } finally {
      hooks.release()
    }
  } finally {
    await manager.close()
  }
})
