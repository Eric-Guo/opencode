import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { RunnerAdmission } from "../src/runner"
import { RunnerInbox } from "../src/runner-inbox"
import { definition, type RunnerTool } from "../src/extensions"
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
  options: { admission?: RunnerAdmission; startupLimit?: number; wake?: () => void; protectedRoots?: string[] } = {},
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
  })
}

test("realtime claims one authoritative task without a list, deduplicates hints, and leaves human work alone", async () => {
  const fixture = await executorFixture()
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const inputs: unknown[] = []
  const runner = inbox(fixture, [
    {
      definition: definition("probe", "Fixture", { value: { type: "string" } }, ["value"]),
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

test("Code Mode and its native file child complete with one startup slot and no polling", async () => {
  const fixture = await executorFixture()
  const runner = inbox(fixture, [], { startupLimit: 1 })
  const child = Promise.withResolvers<JsonObject>()
  const operation = { key: "" }
  await Bun.write(fixture.directory + "/child.txt", "native child bytes")
  fixture.add("run", "parent", "code", {
    tool_input: { code: 'const result = await tools.read({path:"child.txt"}); text(result.content[0].text)' },
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
              tools: [{ function: { name: "read" }, route: { kind: "runner", tool_name: "read" } }],
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
        operation: { type: "operation", position: 1, key: operation.key, receipt: { accepted: true }, outcome: null },
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
    await runner.drain()
    expect(fixture.commits.map((entry) => entry.task)).toEqual(["child", "parent"])
    expect(fixture.commits[1].body).toMatchObject({
      outcome: "completed",
      content: [{ type: "text", text: "native child bytes" }],
    })
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
