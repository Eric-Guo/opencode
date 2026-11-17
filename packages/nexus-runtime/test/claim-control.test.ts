import { afterEach, expect, setSystemTime, test } from "bun:test"
import { ExecutorClient, type ClaimedTask, type OperationEvent } from "@cybros/agent"
import { ClaimDeadline, ClaimLease, ClaimOperations } from "../src/claim-control"
import { RunnerAdmission } from "../src/runner"
import { definition } from "../src/extensions"
import { executorFixture } from "./fixture/executor"

afterEach(() => setSystemTime())

test("claim renewal follows its grant and transient status errors retain execution", async () => {
  const initial = Date.now()
  const calls: string[] = []
  const extensions: number[] = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname

      calls.push(path.split("/").at(-1)!)

      if (path.endsWith("/extend")) {
        extensions.push(((await request.json()) as { timeout_ms: number }).timeout_ms)
        return Response.json({
          claim_token: "claim",
          deadline_at: new Date(initial + 120000).toISOString(),
          task: claimed.task,
        })
      }

      return Response.json({ error: { code: "unavailable" } }, { status: 503 })
    },
  })
  const task = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" }).inboxTask("run", "tool")
  const claimed = {
    claim_token: "claim",
    deadline_at: new Date(initial + 60000).toISOString(),
    task: {},
  } as ClaimedTask
  const lease = new ClaimLease(task, claimed, new AbortController().signal, true, 600000)

  try {
    setSystemTime(initial + 40000)
    await lease.maintain()
    expect(lease.signal.aborted).toBe(false)
    expect(calls).toEqual(["claim", "extend"])
    expect(extensions).toEqual([600000])
  } finally {
    await lease.close()
  }
})

test("execution timeout leaves claim headroom for delivery and renewal is not restarted after the clamp", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "timed", "probe")
  const task = fixture.client.inboxTask("run", "timed")
  const claim = await task.claim()
  const lease = new ClaimLease(task, claim, new AbortController().signal)
  try {
    setSystemTime(lease.deadlineAt - 14000)
    await lease.maintain()
    expect(lease.executionSignal.aborted).toBe(true)
    expect(lease.executionSignal.reason).toBeInstanceOf(ClaimDeadline)
    expect(lease.signal.aborted).toBe(false)
    expect(fixture.calls.some((call) => call.path.endsWith("/extend"))).toBe(false)
    setSystemTime(lease.deadlineAt + 1)
    await lease.maintain()
    expect(lease.signal.aborted).toBe(true)
  } finally {
    await lease.close()
    await fixture.close()
  }
})

test("a claim without a deadline is observed without inventing an execution timeout", async () => {
  const fixture = await executorFixture()
  fixture.control.deadline = null
  fixture.add("run", "unbounded", "probe")
  const task = fixture.client.inboxTask("run", "unbounded")
  const lease = new ClaimLease(task, await task.claim(), new AbortController().signal)
  try {
    setSystemTime(Date.now() + 86400000)
    await lease.maintain()
    expect(lease.deadlineAt).toBe(Infinity)
    expect(lease.executionSignal.aborted).toBe(false)
    expect(fixture.calls.some((call) => call.path.endsWith("/extend"))).toBe(false)
  } finally {
    await lease.close()
    await fixture.close()
  }
})

test("unstarted isolated work cannot renew a claim until its worker acknowledges execution", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "waiting", "probe")
  fixture.add("run", "started", "probe")
  const waitingTask = fixture.client.inboxTask("run", "waiting")
  const startedTask = fixture.client.inboxTask("run", "started")
  const waiting = new ClaimLease(
    waitingTask,
    await waitingTask.claim(),
    new AbortController().signal,
    true,
    60000,
    false,
  )
  const started = new ClaimLease(
    startedTask,
    await startedTask.claim(),
    new AbortController().signal,
    true,
    60000,
    false,
  )
  try {
    started.executionStarted()
    setSystemTime(Math.min(waiting.deadlineAt, started.deadlineAt) - 20000)
    await waiting.maintain()
    await started.maintain()
    expect(fixture.calls.filter((call) => call.path.endsWith("/extend")).map((call) => call.path)).toEqual([
      expect.stringContaining("/started/extend"),
    ])
    setSystemTime(waiting.deadlineAt + 1)
    await waiting.maintain()
    waiting.executionStarted()
    expect(waiting.signal.aborted).toBe(true)
    expect(fixture.calls.filter((call) => call.path.endsWith("/extend"))).toHaveLength(1)
  } finally {
    await Promise.all([waiting.close(), started.close()])
    await fixture.close()
  }
})

test("resource permits stay held until real release and wake blocked inbox work", () => {
  const wakes: string[] = []
  const admission = new RunnerAdmission(() => wakes.push("wake"))
  const tool = {
    definition: definition("device", "Shared device", {}, []),
    resource: { name: "device", concurrency: 1 },
    async execute() {
      return { content: "done" }
    },
  }
  const release = admission.reserve(tool)!

  expect(admission.reserve(tool)).toBeUndefined()
  expect(() => admission.reserve({ ...tool, resource: { name: "device", concurrency: 2 } })).toThrow("Inconsistent")
  release()
  expect(wakes).toEqual(["wake"])
  expect(admission.reserve(tool)).toBeFunction()
})

test("concurrent operations receive their own out-of-order observations and reconcile a lost acceptance", async () => {
  const events: OperationEvent[] = []
  const submitted = Promise.withResolvers<void>()
  const event = (key: string, type: string, position: number): OperationEvent => ({
    key,
    type,
    position,
    request: { kind: "tool", name: key, input: {} },
    receipt: type === "operation" ? { accepted: true } : null,
    outcome: type === "observation" ? { status: "completed", output: key } : null,
    refusal: null,
  })
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname.endsWith("/operations") && request.method === "POST") {
        const input = (await request.json()) as { operation: { key: string } }
        const accepted = event(input.operation.key, "operation", events.length + 1)

        events.push(accepted)
        if (events.length === 2) submitted.resolve()
        if (input.operation.key === "first") return Response.json({ error: { code: "lost_response" } }, { status: 503 })

        return Response.json({ operation: accepted })
      }

      if (url.pathname.endsWith("/operations"))
        return Response.json({
          operations: {
            context: { tools: [], model_defaults: {}, environment: null },
            trace: events,
            position: events.length,
            next_after: null,
          },
        })
      if (url.pathname.endsWith("/observation")) {
        await submitted.promise

        const input = (await request.json()) as { after: number }
        const observation = input.after === 0 ? event("second", "observation", 3) : event("first", "observation", 4)

        return Response.json({ observation, position: observation.position })
      }

      return new Response(null, { status: 404 })
    },
  })
  const client = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" })
  const operations = new ClaimOperations(client.inboxTask("run", "parent"), "claim", AbortSignal.timeout(5000))
  const results = await Promise.all([
    operations.invoke("first", { kind: "tool", name: "first", input: {} }),
    operations.invoke("second", { kind: "tool", name: "second", input: {} }),
  ])

  expect(results).toEqual([
    { status: "completed", output: "first" },
    { status: "completed", output: "second" },
  ])
  expect(events.filter((entry) => entry.key === "first")).toHaveLength(1)
})

test("paused native questions retain their request, recover cursor drift and reuse durable answers", async () => {
  const trace: OperationEvent[] = []
  const submissions: unknown[] = []
  const reads: number[] = []
  const paused = Promise.withResolvers<void>()
  const owner = new AbortController()
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/operations") && request.method === "POST") {
        const body = (await request.json()) as { operation: { key: string; request: Record<string, string> } }
        submissions.push(body)
        if (submissions.length === 1) {
          paused.resolve()
          return Response.json({ error: { code: "execution_paused" } }, { status: 409 })
        }
        const event: OperationEvent = {
          type: "operation",
          key: body.operation.key,
          request: body.operation.request,
          receipt: { task_keys: ["question"] },
          position: 1,
          refusal: null,
          outcome: null,
        }
        trace.push(event)
        return Response.json({ operation: event })
      }
      if (path.endsWith("/observation")) {
        reads.push(((await request.json()) as { after: number }).after)
        trace.push({
          type: "observation",
          key: "question",
          position: 2,
          request: null,
          receipt: null,
          refusal: null,
          outcome: { status: "completed", content: [{ type: "text", text: "accept" }] },
        })
        return Response.json({ error: { code: "operation_position_changed" } }, { status: 409 })
      }
      return Response.json({
        operations: {
          context: { tools: [], model_defaults: {}, environment: null },
          trace,
          position: trace.length,
          next_after: null,
        },
      })
    },
  })
  const task = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" }).inboxTask("run", "parent")
  const request = { kind: "ask", input: { prompt: "Continue?" } }
  const operations = new ClaimOperations(task, "original-claim", owner.signal)
  const waiting = operations.question("question", request)
  await paused.promise
  expect(await waiting).toEqual({ status: "completed", content: [{ type: "text", text: "accept" }] })
  expect(submissions).toHaveLength(2)
  expect(submissions[0]).toEqual(submissions[1])
  expect(reads).toEqual([0])
  expect(await new ClaimOperations(task, "new-claim", owner.signal).question("question", request)).toEqual({
    status: "completed",
    content: [{ type: "text", text: "accept" }],
  })
  await expect(operations.question("question", { kind: "ask", input: { prompt: "Changed" } })).rejects.toThrow(
    "differs",
  )
  expect(submissions).toHaveLength(2)
  owner.abort()
})

test("cancellation during a paused submit prevents another send", async () => {
  const owner = new AbortController()
  const paused = Promise.withResolvers<void>()
  const requests: unknown[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      paused.resolve()
      return Response.json({ error: { code: "execution_paused" } }, { status: 409 })
    },
  })
  const task = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" }).inboxTask("run", "parent")
  const work = new ClaimOperations(task, "claim", owner.signal).invoke("operation", {
    kind: "ask",
    input: { prompt: "Continue?" },
  })
  void work.catch(() => {})
  await paused.promise
  owner.abort(new Error("stopped"))
  await expect(work).rejects.toThrow("stopped")
  expect(requests).toHaveLength(1)
})

test("internally timed tools retain the claim deadline without requesting renewal", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "bash", "bash")
  const task = fixture.client.inboxTask("run", "bash")
  const claim = await task.claim()
  const lease = new ClaimLease(task, claim, new AbortController().signal, false)
  try {
    setSystemTime(Date.now() + 35000)
    await lease.maintain()
    expect(lease.executionSignal.aborted).toBe(false)
    expect(fixture.calls.some((call) => call.path.endsWith("/extend"))).toBe(false)
    expect(lease.deadlineAt).toBe(Date.parse(claim.deadline_at!))
  } finally {
    await lease.close()
    await fixture.close()
  }
})
