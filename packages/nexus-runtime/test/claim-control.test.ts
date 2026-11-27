import { afterEach, expect, setSystemTime, test } from "bun:test"
import { createServer } from "node:http"
import { APIError, ExecutorClient, type ClaimedTask, type JsonObject, type OperationEvent } from "@cybros/agent"
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
  // Nexus records the first acceptance; its response is lost in transit.
  let lost = true
  const client = new ExecutorClient({
    baseURL: server.url.origin,
    credential: "executor",
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { operation?: { key?: string } }) : null

      if (lost && init?.method === "POST" && body?.operation?.key === "first") {
        lost = false
        throw new TypeError("fetch failed")
      }
      return response
    },
  })
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

test("a 5xx submit refusal is final and never reconciles the recorded acceptance", async () => {
  const events: OperationEvent[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")

    if (url.pathname.endsWith("/operations") && request.method === "POST") {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const input = JSON.parse(body) as { operation: { key: string } }

        events.push({
          key: input.operation.key,
          type: "operation",
          position: events.length + 1,
          request: { kind: "tool", name: input.operation.key, input: {} },
          receipt: { accepted: true },
          outcome: null,
          refusal: null,
        })
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { code: "unavailable" } }))
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const client = new ExecutorClient({ baseURL: `http://127.0.0.1:${port}`, credential: "executor" })
  const operations = new ClaimOperations(client.inboxTask("run", "parent"), "claim", AbortSignal.timeout(5000))

  try {
    const failure = await operations
      .invoke("refused", { kind: "tool", name: "refused", input: {} })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(APIError)
    expect((failure as APIError).status).toBe(503)
    expect(events).toHaveLength(1)
  } finally {
    server.close()
  }
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

test("server remaining_ms anchors the claim deadline against host clock skew", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "skewed", "probe")
  const task = fixture.client.inboxTask("run", "skewed")
  const initial = Date.now()
  setSystemTime(initial)
  // The host clock runs an hour ahead of Nexus: deadline_at is long past while the server-measured park stands.
  const claim = {
    task: fixture.rows.get(JSON.stringify(["run", "skewed"]))!,
    claim_token: "token",
    deadline_at: new Date(initial - 3570000).toISOString(),
    remaining_ms: 30000,
  } as ClaimedTask
  fixture.claims.set(JSON.stringify(["run", "skewed"]), "token")
  const lease = new ClaimLease(task, claim, new AbortController().signal)
  try {
    expect(lease.deadlineAt - initial).toBe(30000)
    setSystemTime(initial + 23000)
    await lease.maintain()
    expect(lease.executionSignal.aborted).toBe(true)
    expect(lease.executionSignal.reason).toBeInstanceOf(ClaimDeadline)
    expect(lease.signal.aborted).toBe(false)
    setSystemTime(initial + 30001)
    await lease.maintain()
    expect(lease.signal.aborted).toBe(true)
  } finally {
    await lease.close()
    await fixture.close()
  }
})

test("a transient extension refusal re-arms within the clamp while a typed refusal ends the asking", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "renewed", "probe")
  const task = fixture.client.inboxTask("run", "renewed")
  const initial = Date.now()
  setSystemTime(initial)
  const claim = await task.claim()
  const extensions: number[] = []
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/extend")) return undefined
    extensions.push(Date.now())
    if (extensions.length === 1) return Response.json({ error: { code: "unavailable" } }, { status: 503 })
    if (extensions.length === 3)
      return Response.json({ error: { code: "extension_too_long" } }, { status: 409 })
    return Response.json({
      task: fixture.rows.get(JSON.stringify(["run", "renewed"]))!,
      claim: { claim_token: claim.claim_token, deadline_at: null, remaining_ms: 60000 },
    })
  }
  const lease = new ClaimLease(task, claim, new AbortController().signal)
  try {
    setSystemTime(initial + 30000)
    await lease.maintain()
    expect(extensions.length).toBe(1)
    expect(lease.deadlineAt).toBe(initial + 60000)
    // The transient refusal re-armed two seconds out instead of ending the asking.
    setSystemTime(initial + 31000)
    await lease.maintain()
    expect(extensions.length).toBe(1)
    setSystemTime(initial + 32000)
    await lease.maintain()
    expect(extensions.length).toBe(2)
    expect(lease.deadlineAt).toBe(initial + 92000)
    // The granted park re-arms the next ask at its own half.
    setSystemTime(initial + 62000)
    await lease.maintain()
    expect(extensions.length).toBe(3)
    setSystemTime(initial + 90000)
    await lease.maintain()
    expect(extensions.length).toBe(3)
    expect(lease.signal.aborted).toBe(false)
  } finally {
    await lease.close()
    await fixture.close()
  }
})

test("a transient extension retry re-arms only while it fits before the clamp", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "clamped", "probe")
  const task = fixture.client.inboxTask("run", "clamped")
  const initial = Date.now()
  setSystemTime(initial)
  fixture.control.deadline = new Date(initial + 10000).toISOString()
  const claim = await task.claim()
  const extensions: number[] = []
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/extend")) return undefined
    extensions.push(Date.now())
    const retryAfter = extensions.length === 1 ? "1" : "10"
    return Response.json({ error: { code: "unavailable" } }, { status: 503, headers: { "Retry-After": retryAfter } })
  }
  const lease = new ClaimLease(task, claim, new AbortController().signal)
  try {
    // A 10s park clamps the handler at 7.5s; the first retry (1s) fits, the second (10s) does not.
    setSystemTime(initial + 5000)
    await lease.maintain()
    expect(extensions).toEqual([initial + 5000])
    setSystemTime(initial + 5500)
    await lease.maintain()
    expect(extensions.length).toBe(1)
    setSystemTime(initial + 6000)
    await lease.maintain()
    expect(extensions).toEqual([initial + 5000, initial + 6000])
    setSystemTime(initial + 7000)
    await lease.maintain()
    setSystemTime(initial + 7400)
    await lease.maintain()
    expect(extensions.length).toBe(2)
  } finally {
    await lease.close()
    await fixture.close()
  }
})

test("observation polling backs off from 250ms to two seconds and a wake reads immediately", async () => {
  // Real time: the backoff schedule itself is the contract. Bounds are one-sided where the schedule guarantees them.
  const events: OperationEvent[] = []
  const reads: number[] = []
  const state = { answered: false }
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/operations") && request.method === "POST") {
        const input = (await request.json()) as { operation: { key: string; request: JsonObject } }
        const event: OperationEvent = {
          type: "operation",
          key: input.operation.key,
          position: events.length + 1,
          request: input.operation.request,
          receipt: {},
          refusal: null,
          outcome: null,
        }
        events.push(event)
        return Response.json({ operation: event })
      }
      if (path.endsWith("/observation")) {
        reads.push(Date.now())
        if (!state.answered) return Response.json({ observation: null, position: 1 })
        return Response.json({
          observation: {
            type: "observation",
            key: "op",
            position: 2,
            request: null,
            receipt: null,
            refusal: null,
            outcome: { status: "completed" },
          },
          position: 2,
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  const client = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" })
  const operations = new ClaimOperations(client.inboxTask("run", "parent"), "claim", AbortSignal.timeout(20000))
  const work = operations.invoke("op", { kind: "ask", input: { prompt: "Continue?" } })
  // The uncapped schedule reaches the two-second wait after four reads: 250ms, 500ms, 1000ms.
  await until(() => reads.length >= 4)
  const gaps = reads.slice(1).map((at, index) => at - reads[index])
  expect(gaps[0]).toBeGreaterThanOrEqual(200)
  expect(gaps[1]).toBeGreaterThanOrEqual(400)
  expect(gaps[2]).toBeGreaterThanOrEqual(900)
  // The capped wait is two seconds, not four.
  await until(() => reads.length >= 5, 3000)
  expect(reads[4] - reads[3]).toBeGreaterThanOrEqual(1800)
  expect(reads[4] - reads[3]).toBeLessThan(3000)
  // A wake interrupts the pending wait long before it expires. The settle lets the
  // client park in the capped wait: a wake landing during a read is spent by design.
  await new Promise((resolve) => setTimeout(resolve, 100))
  const wokeAt = Date.now()
  state.answered = true
  operations.wake()
  await until(() => reads.length >= 6)
  expect(reads[5] - wokeAt).toBeLessThan(1000)
  expect(await work).toEqual({ status: "completed" })
}, 15000)

test("a delivered observation restarts the polling backoff", async () => {
  const events: OperationEvent[] = []
  const reads: number[] = []
  const observation = (key: string, position: number): OperationEvent => ({
    type: "observation",
    key,
    position,
    request: null,
    receipt: null,
    refusal: null,
    outcome: { status: "completed", output: key },
  })
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/operations") && request.method === "POST") {
        const input = (await request.json()) as { operation: { key: string; request: JsonObject } }
        const event: OperationEvent = {
          type: "operation",
          key: input.operation.key,
          position: events.length + 1,
          request: input.operation.request,
          receipt: {},
          refusal: null,
          outcome: null,
        }
        events.push(event)
        return Response.json({ operation: event })
      }
      if (path.endsWith("/observation")) {
        reads.push(Date.now())
        if (reads.length === 3) return Response.json({ observation: observation("op1", 3), position: 3 })
        if (reads.length === 5) return Response.json({ observation: observation("op2", 4), position: 4 })
        return Response.json({ observation: null, position: 2 })
      }
      return new Response(null, { status: 404 })
    },
  })
  const client = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" })
  const operations = new ClaimOperations(client.inboxTask("run", "parent"), "claim", AbortSignal.timeout(20000))
  const first = operations.invoke("op1", { kind: "ask", input: { prompt: "One?" } })
  const second = operations.invoke("op2", { kind: "ask", input: { prompt: "Two?" } })
  await until(() => reads.length >= 5)
  const gaps = reads.slice(1).map((at, index) => at - reads[index])
  expect(gaps[0]).toBeGreaterThanOrEqual(200)
  expect(gaps[1]).toBeGreaterThanOrEqual(400)
  // A delivered observation is followed by an immediate re-read; its wait then restarts
  // at 250ms instead of continuing to the doubled 1000ms.
  expect(gaps[2]).toBeLessThan(200)
  expect(gaps[3]).toBeGreaterThanOrEqual(200)
  expect(gaps[3]).toBeLessThan(700)
  expect(await first).toEqual({ status: "completed", output: "op1" })
  expect(await second).toEqual({ status: "completed", output: "op2" })
}, 15000)

async function until(condition: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
