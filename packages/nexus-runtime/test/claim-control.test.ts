import { afterEach, expect, setSystemTime, test } from "bun:test"
import { ExecutorClient, type ClaimedTask, type OperationEvent } from "@cybros/agent"
import { ClaimLease, ClaimOperations } from "../src/claim-control"
import { RunnerAdmission } from "../src/runner"
import { definition } from "../src/extensions"

afterEach(() => setSystemTime())

test("claim renewal follows its grant and transient status errors retain execution", async () => {
  const initial = Date.now()
  const calls: string[] = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname

      calls.push(path.split("/").at(-1)!)

      if (path.endsWith("/extend"))
        return Response.json({
          claim_token: "claim",
          deadline_at: new Date(initial + 120000).toISOString(),
          task: claimed.task,
        })

      return Response.json({ error: { code: "unavailable" } }, { status: 503 })
    },
  })
  const task = new ExecutorClient({ baseURL: server.url.origin, credential: "executor" }).inboxTask("run", "tool")
  const claimed = {
    claim_token: "claim",
    deadline_at: new Date(initial + 60000).toISOString(),
    task: {},
  } as ClaimedTask
  const lease = new ClaimLease(task, claimed, new AbortController().signal)

  try {
    setSystemTime(initial + 30001)
    await lease.maintain()
    expect(lease.signal.aborted).toBe(false)
    expect(calls).toEqual(["claim", "extend"])
  } finally {
    await lease.close()
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
