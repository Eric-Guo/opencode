import { expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import { ExtensionManager } from "../src/extension-manager"
import { Configuration } from "../src/configuration"
import { RunnerAdmission } from "../src/runner"
import { RunnerInbox } from "../src/runner-inbox"
import { definition, type RunnerContext, type RunnerTool } from "../src/extensions"
import { executorFixture } from "./fixture/executor"

const nudge = (run: string, task: string, tool: string) => ({
  event: {
    type: "work_available",
    kind: "tool_call",
    run_public_id: run,
    task_key: task,
    tool_name: tool,
    role: "runner",
  },
})
const canceled = (run: string, task: string) => ({
  event: { type: "work_canceled", run_public_id: run, task_key: task },
})

function inbox(
  fixture: Awaited<ReturnType<typeof executorFixture>>,
  tools: RunnerTool[],
  options: {
    admission?: RunnerAdmission
    startupLimit?: number
    wake?: () => void
    protectedRoots?: string[]
    hooks?: () => ReturnType<ExtensionManager["captureTools"]>
  } = {},
) {
  return new RunnerInbox({
    executor: fixture.client,
    id: "executor",
    root: fixture.directory,
    journal: fixture.journal,
    signal: new AbortController().signal,
    extensions: () => tools,
    admission: options.admission ?? new RunnerAdmission(),
    startupLimit: options.startupLimit ?? 8,
    wake: options.wake ?? (() => {}),
    protectedRoots: options.protectedRoots,
    hooks: options.hooks,
  })
}

test("realtime claims one authoritative task without a list, deduplicates hints, and leaves human work alone", async () => {
  const fixture = await executorFixture()
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const inputs: unknown[] = []
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", { value: { type: "string", pattern: "^from Nexus$" } }, ["value"]),
      async execute(input) {
        inputs.push(input)
        started.resolve()
        await gate.promise
        return { content: "authoritative" }
      },
    },
  ])
  fixture.add("run", "task", "probe", { tool_input: { value: "from Nexus" } })
  try {
    runner.notify({ event: { ...nudge("run", "task", "probe").event, tool_input: { value: "from cable" } } })
    runner.notify(nudge("run", "task", "probe"))
    runner.notify({ event: { ...nudge("run", "ask", "probe").event, kind: "ask" } })
    runner.notify({ event: { ...nudge("run", "approval", "probe").event, kind: "approval" } })
    runner.notify({ event: { type: "unknown" } })
    runner.notify("malformed")
    await started.promise
    expect(inputs).toEqual([{ value: "from Nexus" }])
    expect(fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/claim"))).toHaveLength(1)
    expect(fixture.calls.some((call) => call.path.endsWith("/inbox"))).toBe(false)
    gate.resolve()
    await runner.drain()
    await runner.close()
    expect(fixture.commits).toHaveLength(1)
    expect(fixture.commits[0].body).toMatchObject({ outcome: "completed", content: "authoritative" })
    expect(runner.snapshot().claimed).toBe(1)
  } finally {
    gate.resolve()
    await runner.close()
    await fixture.close()
  }
})

test("startup admission is bounded before HTTP claim while waiting handlers leave capacity for children", async () => {
  const fixture = await executorFixture()
  const claims = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const allStarted = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const state = { claims: 0, handlers: 0, wakes: 0 }
  fixture.control.beforeClaim = async () => {
    if (++state.claims === 2) claims.resolve()
    await release.promise
  }
  const runner = inbox(
    fixture,
    [
      {
        definition: definition("waiter", "Fixture", {}, []),
        async execute() {
          if (++state.handlers === 2) waiting.resolve()
          if (state.handlers === 3) allStarted.resolve()
          await finish.promise
          return { content: "done" }
        },
      },
    ],
    {
      startupLimit: 2,
      wake: () => {
        state.wakes++
      },
    },
  )
  fixture.add("run", "first", "waiter")
  fixture.add("run", "second", "waiter")
  fixture.add("run", "child", "waiter")
  try {
    runner.notify(nudge("run", "first", "waiter"))
    runner.notify(nudge("run", "second", "waiter"))
    runner.notify(nudge("run", "child", "waiter"))
    await claims.promise
    expect(state.claims).toBe(2)
    expect(runner.snapshot().starting).toBe(2)
    release.resolve()
    await waiting.promise
    await runner.sweep()
    await allStarted.promise
    expect(state.claims).toBe(3)
    expect(state.handlers).toBe(3)
    expect(runner.snapshot().starting).toBe(0)
    expect(state.wakes).toBeGreaterThan(0)
    finish.resolve()
    await runner.drain()
    await runner.close()
    expect(fixture.commits).toHaveLength(3)
  } finally {
    release.resolve()
    finish.resolve()
    await runner.close()
    await fixture.close()
  }
})

test("cancellation matches both run and task, and non-cooperative handlers retain shared permits across replacement", async () => {
  const fixture = await executorFixture()
  const started = Promise.withResolvers<void>()
  const late = Promise.withResolvers<void>()
  const available = Promise.withResolvers<void>()
  const admission = new RunnerAdmission()
  const tool: RunnerTool = {
    definition: definition("device", "Fixture", {}, []),
    resource: { name: "device", concurrency: 1 },
    async execute(_, ctx) {
      if (ctx.run === "old") {
        started.resolve()
        await late.promise
      }
      return { content: "device completed" }
    },
  }
  const old = inbox(fixture, [tool], { admission })
  const next = inbox(fixture, [tool], { admission, wake: () => available.resolve() })
  fixture.add("old", "same-key", "device")
  fixture.add("new", "same-key", "device")
  try {
    old.notify(nudge("old", "same-key", "device"))
    await started.promise
    old.notify(canceled("another-run", "same-key"))
    expect(old.snapshot().canceled).toBe(0)
    old.notify(canceled("old", "same-key"))
    await old.close()
    expect(fixture.commits[0].body).toMatchObject({
      outcome: "failed",
      content: expect.stringContaining("interrupted"),
    })
    next.notify(nudge("new", "same-key", "device"))
    expect(next.snapshot().starting).toBe(0)
    expect(fixture.claims.size).toBe(1)
    late.resolve()
    await available.promise
    await next.sweep()
    await next.drain()
    await next.close()
    expect(fixture.commits).toHaveLength(2)
    expect(fixture.commits[1].body).toMatchObject({ outcome: "completed", content: "device completed" })
    expect(old.snapshot().in_flight).toBe(0)
  } finally {
    late.resolve()
    await Promise.all([old.close(), next.close()])
    await fixture.close()
  }
})

test("sweeps advance one bounded page, recover a missed nudge, and never claim another address or a held task", async () => {
  const fixture = await executorFixture()
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", {}, []),
      async execute() {
        return { content: "swept" }
      },
    },
  ])
  const first = fixture.add("run", "first", "probe")
  const second = fixture.add("run", "second", "probe")
  fixture.control.pages = [
    {
      tasks: [
        first,
        { ...first, task_key: "foreign", addressed_to: { ...first.addressed_to!, executor_public_id: "other" } },
        { ...first, task_key: "held", claimed: true },
        { ...first, kind: "approval", task_key: "approval" },
      ],
      next: "1",
    },
    { tasks: [second], next: null },
  ]
  try {
    await runner.sweep()
    expect(fixture.calls.filter((call) => call.path.endsWith("/inbox"))).toMatchObject([{ after: null, limit: "50" }])
    expect(fixture.claims.size).toBe(1)
    await runner.sweep()
    expect(fixture.calls.filter((call) => call.path.endsWith("/inbox"))).toMatchObject([
      { after: null },
      { after: "1" },
    ])
    expect(fixture.claims.size).toBe(2)
    await runner.drain()
    await runner.close()
    expect(fixture.commits.every((entry) => entry.body.outcome === "completed")).toBe(true)
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("schema refusals are returned data, handler failures fail the task, and admission drift executes nothing", async () => {
  const fixture = await executorFixture()
  const called: string[] = []
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", { value: { type: "string" } }, ["value"]),
      async execute() {
        called.push("probe")
        return { is_error: true, content: "Tool refused" }
      },
    },
    {
      definition: definition("thrower", "Fixture", {}, []),
      async execute() {
        called.push("thrower")
        throw new Error("Handler failed")
      },
    },
    {
      definition: definition("device", "Fixture", {}, []),
      resource: { name: "device", concurrency: 1 },
      async execute() {
        called.push("device")
        return { content: "wrong permit" }
      },
    },
  ])
  fixture.add("run", "invalid", "probe", { tool_input: { value: 42 } })
  fixture.add("run", "returned-error", "probe", { tool_input: { value: "valid" } })
  fixture.add("run", "thrown", "thrower")
  fixture.add("run", "drift", "device")
  fixture.add("run", "placement", "probe", { executor_context: { "opencode.directory": "/wrong" } })
  fixture.add("run", "wrong-role", "probe", {
    addressed_to: { role: "agent", executor_public_id: "executor", presence: "online", last_seen_at: null },
  })
  fixture.add("run", "unknown", "uninstalled")
  try {
    runner.notify(nudge("run", "invalid", "probe"))
    runner.notify(nudge("run", "returned-error", "probe"))
    runner.notify(nudge("run", "thrown", "thrower"))
    runner.notify(nudge("run", "drift", "probe"))
    runner.notify(nudge("run", "placement", "probe"))
    runner.notify({ event: { ...nudge("run", "wrong-role", "probe").event, role: "agent" } })
    runner.notify(nudge("run", "unknown", "uninstalled"))
    await runner.drain()
    await runner.close()
    const result = (key: string) => fixture.commits.find((row) => row.task === key)!.body
    expect(result("invalid")).toMatchObject({
      outcome: "completed",
      is_error: true,
      content: expect.stringContaining("invalid_tool_arguments"),
    })
    expect(result("returned-error")).toMatchObject({ outcome: "completed", is_error: true, content: "Tool refused" })
    expect(result("thrown")).toMatchObject({ outcome: "failed", content: "Handler failed" })
    expect(result("drift")).toMatchObject({ outcome: "failed", content: expect.stringContaining("admission changed") })
    expect(result("placement")).toMatchObject({ outcome: "failed", content: expect.stringContaining("placement") })
    expect(result("wrong-role")).toMatchObject({ outcome: "failed", content: expect.stringContaining("role") })
    expect(result("unknown")).toMatchObject({ outcome: "failed", content: expect.stringContaining("no longer serves") })
    expect(called.sort()).toEqual(["probe", "thrower"])
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("the native claim boundary returns shared policy refusals before invoking a handler", async () => {
  const fixture = await executorFixture()
  const called: string[] = []
  const runner = inbox(
    fixture,
    ["bash", "write"].map((name) => ({
      definition: definition(name, "Fixture", { command: { type: "string" }, path: { type: "string" } }, []),
      async execute() {
        called.push(name)
        return { content: "safe fixture" }
      },
    })),
    { protectedRoots: [fixture.directory + "/private"] },
  )
  fixture.add("run", "force", "bash", { tool_input: { command: "git push --force" } })
  fixture.add("run", "private", "write", { tool_input: { path: "private/credentials" } })
  fixture.add("run", "safe", "bash", { tool_input: { command: "git status" } })
  try {
    runner.notify(nudge("run", "force", "bash"))
    runner.notify(nudge("run", "private", "write"))
    runner.notify(nudge("run", "safe", "bash"))
    await runner.drain()
    expect(called).toEqual(["bash"])
    for (const key of ["force", "private"])
      expect(fixture.commits.find((row) => row.task === key)!.body).toMatchObject({
        outcome: "completed",
        is_error: true,
        content: expect.stringContaining("Refused:"),
      })
    expect(fixture.commits.find((row) => row.task === "safe")!.body).toMatchObject({
      outcome: "completed",
      content: "safe fixture",
    })
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("lost settlement responses reconcile, throttled results stay durable, and recovery never reruns the handler", async () => {
  const fixture = await executorFixture()
  const executions: string[] = []
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", {}, []),
      async execute(_, ctx) {
        executions.push(ctx.task)
        return { content: "result " + ctx.task }
      },
    },
  ])
  fixture.add("run", "lost", "probe")
  fixture.add("run", "throttled", "probe")
  fixture.control.lostCommitResponse = true
  try {
    runner.notify(nudge("run", "lost", "probe"))
    await runner.drain()
    await runner.close()
    expect(await fixture.pending()).toEqual([])
    const restored = inbox(fixture, [
      {
        definition: definition("probe", "Fixture", {}, []),
        async execute(_, ctx) {
          executions.push(ctx.task)
          return { content: "result " + ctx.task }
        },
      },
    ])
    fixture.control.refuseCommit = () =>
      Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "3600" } })
    restored.notify(nudge("run", "throttled", "probe"))
    await restored.drain()
    await restored.close()
    expect(await fixture.pending()).toHaveLength(1)
    fixture.control.refuseCommit = undefined
    const recovered = inbox(fixture, [])
    await recovered.sweep()
    await recovered.close()
    expect(await fixture.pending()).toEqual([])
    expect(executions).toEqual(["lost", "throttled"])
    expect(fixture.commits.filter((entry) => entry.task === "lost")).toHaveLength(1)
    expect(fixture.results.get(JSON.stringify(["run", "throttled"]))).toMatchObject({ content: "result throttled" })
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("Code Mode prints one native child result and retains structured false with one startup slot", async () => {
  const fixture = await executorFixture()
  const runner = inbox(fixture, [], { startupLimit: 1 })
  const child = Promise.withResolvers<JsonObject>()
  const operation = { key: "" }
  await Bun.write(fixture.directory + "/child.txt", "native child bytes")
  fixture.add("run", "parent", "code", {
    tool_input: {
      code: 'const result = await tools.read({path:"child.txt"}); value(false); text("before"); console.log(JSON.stringify(result)); text("after");',
    },
  })
  fixture.control.committed = (_, task, body) => {
    if (task === "child") child.resolve(body)
  }
  fixture.control.route = async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/parent/operations")) {
      if (request.method === "GET")
        return Response.json({
          operations: {
            context: {
              tools: [
                {
                  function: { name: "code", parameters: { $id: "urn:opencode:nexus:codemode:1" } },
                  canonical: "code",
                },
                { function: { name: "read" }, route: { kind: "runner", tool_name: "read" } },
              ],
              model_defaults: {},
              environment: null,
            },
            trace: [],
            position: 0,
            next_after: null,
          },
        })
      const body = (await request.json()) as {
        claim_token: string
        operation: { key: string; request: { kind: string; name: string; input: { path: string } } }
      }
      expect(fixture.claims.get(JSON.stringify(["run", "parent"]))).toBe(body.claim_token)
      expect(body.operation.request).toEqual({ kind: "tool", name: "read", input: { path: "child.txt" } })
      expect(runner.snapshot().starting).toBe(0)
      operation.key = body.operation.key
      fixture.add("run", "child", "read", { tool_input: body.operation.request.input })
      runner.notify(nudge("run", "child", "read"))
      return Response.json({
        operation: {
          type: "operation",
          position: 1,
          key: operation.key,
          request: body.operation.request,
          receipt: { accepted: true },
          outcome: null,
        },
      })
    }
    if (path.endsWith("/parent/observation")) {
      const result = await child.promise
      return Response.json({
        position: 2,
        observation: {
          type: "observation",
          position: 2,
          key: operation.key,
          outcome: { status: "completed", is_error: false, content: [{ type: "text", text: result.content }] },
        },
      })
    }
  }
  try {
    runner.notify(nudge("run", "parent", "code"))
    runner.notify(nudge("run", "parent", "code"))
    await runner.drain()
    expect(fixture.commits.map((entry) => entry.task)).toEqual(["child", "parent"])
    expect(fixture.commits[1].body).toMatchObject({
      outcome: "completed",
      content: [
        { type: "text", text: "before" },
        {
          type: "text",
          text: '{"status":"completed","is_error":false,"content":[{"type":"text","text":"native child bytes"}]}',
        },
        { type: "text", text: "after" },
      ],
      structured_content: false,
    })
    expect(
      fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/parent/operations")),
    ).toHaveLength(1)
    expect(fixture.calls.some((call) => call.path.endsWith("/inbox"))).toBe(false)
  } finally {
    child.resolve({ content: "canceled" })
    await runner.close()
    await fixture.close()
  }
})

test("transient and quiet claim failures release admission, while lost executor authority stops further claims", async () => {
  const fixture = await executorFixture()
  const executed: string[] = []
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", {}, []),
      async execute(_, ctx) {
        executed.push(ctx.task)
        return { content: "done" }
      },
    },
  ])
  const fault = { transient: true }
  fixture.control.refuseClaim = (_, task) => {
    if (task === "expired") return Response.json({ error: { code: "not_found" } }, { status: 404 })
    if (task === "transient" && fault.transient)
      return Response.json({ error: { code: "unavailable" } }, { status: 503 })
    if (task === "revoked") return Response.json({ error: { code: "unauthorized" } }, { status: 401 })
  }
  fixture.add("run", "expired", "probe")
  fixture.add("run", "transient", "probe")
  fixture.add("run", "healthy", "probe")
  try {
    runner.notify(nudge("run", "expired", "probe"))
    runner.notify(nudge("run", "transient", "probe"))
    runner.notify(nudge("run", "healthy", "probe"))
    await runner.drain()
    expect(executed).toEqual(["healthy"])
    expect(runner.snapshot().starting).toBe(0)
    expect(runner.snapshot().running).toBe(true)
    fault.transient = false
    await runner.sweep()
    await runner.drain()
    expect(executed).toEqual(["healthy", "transient"])
    fixture.add("run", "revoked", "probe")
    runner.notify(nudge("run", "revoked", "probe"))
    await runner.drain()
    await expect(runner.sweep()).rejects.toThrow()
    const requests = fixture.calls.length
    fixture.add("run", "after-revoke", "probe")
    runner.notify(nudge("run", "after-revoke", "probe"))
    await runner.drain()
    expect(fixture.calls).toHaveLength(requests)
    expect(runner.snapshot().issue?.code).toBe("unauthorized")
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("journal recovery observes live ownership when a nudge starts during its file scan", async () => {
  const fixture = await executorFixture()
  const reading = Promise.withResolvers<string>()
  const resume = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const state = { incoming: "", firstRead: true }
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", {}, []),
      async execute(_, ctx) {
        if (ctx.task === state.incoming) {
          started.resolve()
          await finish.promise
        }
        return { content: "executed " + ctx.task }
      },
    },
  ])
  fixture.add("run", "one", "probe")
  fixture.add("run", "two", "probe")
  await fixture.journal.save({ run: "run", task: "one", token: "old-one" })
  await fixture.journal.save({ run: "run", task: "two", token: "old-two" })
  fixture.control.route = async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path.endsWith("/claim") && state.firstRead) {
      state.firstRead = false
      reading.resolve(path.split("/").at(-2)!)
      await resume.promise
      return Response.json({ claim: { active: false } })
    }
  }
  const sweeping = runner.sweep()
  try {
    // Select whichever file recovery has not read yet; directory enumeration order is platform-dependent.
    state.incoming = (await reading.promise) === "one" ? "two" : "one"
    runner.notify(nudge("run", state.incoming, "probe"))
    await started.promise
    resume.resolve()
    await sweeping
    expect(fixture.commits.some((entry) => entry.task === state.incoming)).toBe(false)
    finish.resolve()
    await runner.drain()
    expect(fixture.commits.find((entry) => entry.task === state.incoming)?.body).toMatchObject({
      outcome: "completed",
      content: "executed " + state.incoming,
    })
    expect(fixture.commits).toHaveLength(2)
  } finally {
    resume.resolve()
    finish.resolve()
    await sweeping
    await runner.close()
    await fixture.close()
  }
})

test("claims execute their captured alternate root, report owned progress, and protect resolved runtime paths", async () => {
  const fixture = await executorFixture()
  const alternate = join(fixture.directory, "alternate")
  const protectedRoot = join(fixture.directory, "private")
  await Promise.all([mkdir(alternate), mkdir(protectedRoot)])
  await writeFile(join(protectedRoot, "secret"), "unchanged")
  await symlink(protectedRoot, join(alternate, "link"))
  const progress: unknown[] = []
  let processProgress: RunnerContext["processProgress"]
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/executor/progress")) return
    progress.push(await request.json())
    return new Response(null, { status: 202 })
  }
  const runner = inbox(
    fixture,
    [
      {
        definition: definition("placement", "placement", {}, []),
        async execute(_, context) {
          await context.progress!("working")
          processProgress = context.processProgress
          return { content: context.directory }
        },
      },
    ],
    { protectedRoots: [protectedRoot] },
  )
  fixture.add("run", "place", "placement", {
    executor_context: { "opencode.environment": { root: alternate, directories: [alternate, fixture.directory] } },
  })
  fixture.add("run", "guard", "write", {
    executor_context: { "opencode.directory": alternate },
    tool_input: { path: "link/secret", content: "blocked" },
  })
  fixture.add("run", "bytes", "files_bytes", {
    executor_context: { "opencode.directory": alternate },
    tool_input: { path: join(protectedRoot, "secret") },
  })
  const invalidDirectories = [["relative"], [join(alternate, "missing")], [join(alternate, "link")]]
  invalidDirectories.forEach((directories, index) =>
    fixture.add("run", "invalid-" + index, "placement", {
      executor_context: { "opencode.environment": { root: alternate, directories } },
    }),
  )
  try {
    await runner.sweep()
    await runner.drain()
    await processProgress!({ process_id: "p1", lines: ["still running"], exit: null })
    expect(fixture.results.get(JSON.stringify(["run", "place"]))?.content).toBe(alternate)
    invalidDirectories.forEach((_, index) =>
      expect(fixture.results.get(JSON.stringify(["run", "invalid-" + index]))).toMatchObject({
        outcome: "failed",
        content: expect.stringContaining("placement"),
      }),
    )
    expect(progress).toEqual([
      {
        frame: {
          run_public_id: "run",
          task_key: "place",
          claim_token: fixture.claims.get(JSON.stringify(["run", "place"])),
          text_tail: "working",
        },
      },
      {
        frame: {
          process_id: "p1",
          lines: ["still running"],
          exit: null,
          conversation_public_id: "conversation",
          source: {
            run_public_id: "run",
            task_key: "place",
            claim_token: fixture.claims.get(JSON.stringify(["run", "place"])),
          },
        },
      },
    ])
    expect(fixture.results.get(JSON.stringify(["run", "guard"]))?.is_error).toBe(true)
    expect(fixture.results.get(JSON.stringify(["run", "bytes"]))?.is_error).toBe(true)
    expect(await readFile(join(protectedRoot, "secret"), "utf8")).toBe("unchanged")
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("captured editor reads and edits preserve unsaved buffers and do not fall back after bridge errors", async () => {
  const fixture = await executorFixture()
  const path = join(fixture.directory, "file")
  await writeFile(path, "disk")
  const buffer = { content: "unsaved", closed: false }
  fixture.control.route = async (request) => {
    const operation = new URL(request.url).pathname
    if (!["/fs/read", "/fs/write"].includes(operation)) return
    expect(request.headers.get("authorization")).toBe("Bearer editor-token")
    const input = (await request.json()) as { path: string; session: string; content: string }
    expect(input.path).toBe(path)
    expect(input.session).toBe("editor")
    if (buffer.closed) return new Response("closed", { status: 410 })
    if (operation === "/fs/read") return Response.json({ content: buffer.content })
    buffer.content = input.content
    return Response.json({})
  }
  const runner = inbox(fixture, [])
  const executor_context = {
    "opencode.directory": fixture.directory,
    "opencode.editor": {
      url: fixture.server.url.origin,
      token: "editor-token",
      session: "editor",
      roots: [fixture.directory],
      read: true,
      write: true,
    },
  }
  try {
    fixture.add("run", "read", "read", { executor_context, tool_input: { path: "file" } })
    await runner.sweep()
    await runner.drain()
    expect(fixture.results.get(JSON.stringify(["run", "read"]))?.content).toBe("unsaved")
    fixture.add("run", "edit", "edit", {
      executor_context,
      tool_input: { path: "file", edits: [{ oldText: "unsaved", newText: "buffer edit" }] },
    })
    await runner.sweep()
    await runner.drain()
    expect(buffer.content).toBe("buffer edit")
    expect(await readFile(path, "utf8")).toBe("disk")
    buffer.closed = true
    fixture.add("run", "closed", "write", {
      executor_context,
      tool_input: { path: "file", content: "must not write disk" },
    })
    await runner.sweep()
    await runner.drain()
    expect(fixture.results.get(JSON.stringify(["run", "closed"]))?.is_error).toBe(true)
    expect(await readFile(path, "utf8")).toBe("disk")
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("executor validates rewritten arguments, skips vetoed effects and applies result hooks before durable settlement", async () => {
  const fixture = await executorFixture()
  const calls: string[] = []
  const manager = new ExtensionManager(
    new Configuration(join(fixture.directory, "configuration.json")),
    [
      {
        descriptor: {
          id: "fixture",
          name: "Fixture",
          description: "Tool hooks",
          default_enabled: true,
          configuration_version: 1,
          configuration_schema: { type: "object" },
          defaults: {},
        },
        register(api) {
          api.registerTool({
            definition: definition("probe", "Probe", { value: { type: "string" } }, ["value"]),
            async execute(input) {
              calls.push(String(input.value))
              return { content: "effect:" + input.value }
            },
          })
          api.on("experimental.tool.call", (call) => {
            if (call.context.task === "veto") return { veto: "no effects" }
            if (call.context.task === "invalid") return { rewrite: { value: 42 } }
            return { rewrite: { value: "rewritten" } }
          })
          api.on("experimental.tool.result", (call) => ({ ...call.result, content: call.result.content + ":observed" }))
          api.on("experimental.tool.result", () => {
            throw new Error("observer failure")
          })
        },
      },
    ],
    fixture.directory,
    new AbortController().signal,
    async () => {},
  )
  await manager.start()
  const runner = inbox(fixture, manager.tools(), { hooks: () => manager.captureTools() })
  for (const key of ["rewrite", "veto", "invalid"]) fixture.add("run", key, "probe", { tool_input: {} })
  try {
    for (const key of ["rewrite", "veto", "invalid"]) runner.notify(nudge("run", key, "probe"))
    await runner.drain()
    expect(calls).toEqual(["rewritten"])
    expect(fixture.commits.find((row) => row.task === "rewrite")!.body).toMatchObject({
      outcome: "completed",
      content: "effect:rewritten:observed",
    })
    expect(fixture.commits.find((row) => row.task === "veto")!.body).toMatchObject({
      outcome: "completed",
      is_error: true,
      content: "no effects",
    })
    expect(fixture.commits.find((row) => row.task === "invalid")!.body).toMatchObject({
      outcome: "completed",
      is_error: true,
      content: expect.stringContaining("invalid_tool_arguments"),
    })
  } finally {
    await runner.close()
    await manager.close()
    await fixture.close()
  }
})

test("a new Code Mode VM cannot reconstruct a claim with existing operation history", async () => {
  const fixture = await executorFixture()
  const runner = inbox(fixture, [])
  fixture.add("run", "parent", "code", { tool_input: { code: 'text("source ran")' } })
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/operations")) return
    expect(request.method).toBe("GET")
    return Response.json({
      operations: {
        context: { tools: [], model_defaults: {}, environment: null },
        trace: [
          {
            type: "operation",
            key: "old",
            request: { kind: "tool", name: "read", input: {} },
            receipt: {},
            position: 1,
          },
        ],
        position: 1,
        next_after: null,
      },
    })
  }
  try {
    runner.notify(nudge("run", "parent", "code"))
    await runner.drain()
    expect(fixture.commits[0].body).toMatchObject({
      outcome: "failed",
      content: expect.stringContaining("previous execution state is unavailable"),
    })
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("native filesystem refusals settle as tool errors so callers can correct them", async () => {
  const fixture = await executorFixture()
  const runner = inbox(fixture, [], { startupLimit: 16 })
  await writeFile(join(fixture.directory, "text"), "repeat repeat")
  await writeFile(join(fixture.directory, "binary"), Buffer.from([255]))
  const calls: { name: string; input: JsonObject; message: string }[] = [
    { name: "read", input: { path: "missing" }, message: "ENOENT" },
    { name: "read", input: { path: "." }, message: "regular" },
    { name: "read", input: { path: "text", offset: 5 }, message: "beyond end" },
    { name: "ls", input: { path: "text" }, message: "ENOTDIR" },
    { name: "grep", input: { path: "missing", pattern: "x" }, message: "ENOENT" },
    { name: "find", input: { path: "text", pattern: "*" }, message: "directory" },
    { name: "write", input: { path: ".", content: "x" }, message: "regular" },
    { name: "edit", input: { path: "missing", edits: [{ oldText: "a", newText: "b" }] }, message: "missing" },
    { name: "edit", input: { path: "text", edits: [{ oldText: "repeat", newText: "x" }] }, message: "exactly once" },
    { name: "edit", input: { path: "binary", edits: [{ oldText: "a", newText: "b" }] }, message: "encoded data" },
    { name: "files_bytes", input: { path: "." }, message: "regular" },
  ]
  calls.forEach((call, index) => fixture.add("run", String(index), call.name, { tool_input: call.input }))
  try {
    await runner.sweep()
    await runner.drain()
    calls.forEach((call, index) =>
      expect(fixture.results.get(JSON.stringify(["run", String(index)]))).toMatchObject({
        outcome: "completed",
        is_error: true,
        content: expect.stringContaining(call.message),
      }),
    )
    expect(await readFile(join(fixture.directory, "text"), "utf8")).toBe("repeat repeat")
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("environment independent tools execute without captured placement and still validate arguments", async () => {
  const fixture = await executorFixture()
  const seen: string[] = []
  const runner = inbox(
    fixture,
    [false, true].map((required) => ({
      environmentRequired: required,
      definition: {
        ...definition(required ? "local" : "remote", "Probe", {}, []),
        input_schema: {
          type: "object",
          properties: {
            value: { type: "string", pattern: "^valid$" },
            flag: { type: "boolean" },
            token: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
          if: { properties: { flag: { const: true } }, required: ["flag"] },
          then: { required: ["token"] },
        },
      },
      async execute(_, context) {
        seen.push(context.directory)
        return { content: "executed" }
      },
    })),
  )
  fixture.add("run", "remote", "remote", { executor_context: {}, tool_input: { value: "valid" } })
  fixture.add("run", "invalid", "remote", { executor_context: {}, tool_input: { value: "wrong" } })
  fixture.add("run", "extra", "remote", { executor_context: {}, tool_input: { value: "valid", extra: true } })
  fixture.add("run", "conditional", "remote", { executor_context: {}, tool_input: { value: "valid", flag: true } })
  fixture.add("run", "local", "local", { executor_context: {}, tool_input: { value: "valid" } })
  try {
    await runner.sweep()
    await runner.drain()
    expect(seen).toEqual([fixture.directory])
    expect(fixture.results.get(JSON.stringify(["run", "remote"]))?.content).toBe("executed")
    expect(fixture.results.get(JSON.stringify(["run", "invalid"]))).toMatchObject({
      outcome: "completed",
      is_error: true,
    })
    expect(fixture.results.get(JSON.stringify(["run", "extra"]))).toMatchObject({
      outcome: "completed",
      is_error: true,
    })
    expect(fixture.results.get(JSON.stringify(["run", "conditional"]))).toMatchObject({
      outcome: "completed",
      is_error: true,
      content: expect.stringContaining("token"),
    })
    expect(fixture.results.get(JSON.stringify(["run", "local"]))?.outcome).toBe("failed")
  } finally {
    await runner.close()
    await fixture.close()
  }
})

test("built-in policy changes gate dispatch and checkpoint capture while running calls retain their policy", async () => {
  const { Checkpoints } = await import("../src/checkpoints")
  const { tools, operatorTools } = await import("../src/runner")
  const fixture = await executorFixture()
  const captured = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const history = new Checkpoints(join(fixture.directory, "history"), join(fixture.directory, "project"), {
    maxFileBytes: 4,
    maxTreeBytes: 100,
    retentionDays: 2,
  })
  const root = join(fixture.directory, "bound")
  await mkdir(root)
  await writeFile(join(root, "large"), "too large for this capture")
  const state = { enabled: true }
  const runner = new RunnerInbox({
    executor: fixture.client,
    id: "executor",
    root: fixture.directory,
    journal: fixture.journal,
    signal: new AbortController().signal,
    admission: new RunnerAdmission(),
    wake() {},
    extensions: () => [
      {
        definition: definition("held", "A held write", {}, []),
        async execute() {
          captured.resolve()
          await release.promise
          return { content: "finished" }
        },
      },
    ],
    builtins: () => ({
      tools: state.enabled ? [...tools, ...operatorTools] : [],
      bashTimeoutSeconds: 42,
      checkpoints: state.enabled ? history : undefined,
    }),
  })
  const add = (key: string, tool: string, tool_input: JsonObject = {}) =>
    fixture.add("run-" + key, key, tool, {
      executor_context: { "opencode.environment": { root } },
      tool_input,
    })
  try {
    add("held", "held")
    runner.notify(nudge("run-held", "held", "held"))
    await captured.promise
    state.enabled = false
    release.resolve()
    await runner.drain()
    expect(fixture.commits[0].body.metadata).toMatchObject({ checkpoint: { hash: expect.any(String) } })
    for (const tool of ["read", "write", "checkpoints", "checkpoint_restore"]) {
      add(tool, tool, tool === "write" ? { path: "blocked", content: "no" } : { path: "large" })
      runner.notify(nudge("run-" + tool, tool, tool))
    }
    await runner.drain()
    expect(fixture.commits.slice(1).every((row) => row.body.outcome === "failed")).toBe(true)
    expect(await Bun.file(join(root, "blocked")).exists()).toBe(false)
    add("uncaptured", "held")
    runner.notify(nudge("run-uncaptured", "uncaptured", "held"))
    await runner.drain()
    expect(fixture.commits.at(-1)!.body.metadata).toBeUndefined()
    state.enabled = true
    add("enabled-write", "write", { path: "small", content: "yes" })
    runner.notify(nudge("run-enabled-write", "enabled-write", "write"))
    await runner.drain()
    expect(await Bun.file(join(root, "small")).text()).toBe("yes")
    const records = await history.forRoot(root).records("run-held")
    expect(records.structured_content.records).toHaveLength(1)
    expect(
      (await history.forRoot(root).query({ run_public_id: "run-held" }, new AbortController().signal)).content,
    ).toContain("large")
    expect(await history.prune(Date.now() + 3 * 86400000)).toBe(2)
  } finally {
    release.resolve()
    await runner.close()
    await fixture.close()
  }
})
