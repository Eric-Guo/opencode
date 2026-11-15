import { expect, test } from "bun:test"
import { NexusExecutor, RunnerAdmission } from "../src/executor"
import { definition } from "../src/extensions"
import { executorFixture } from "./fixture/executor"

test("reusable executor dispatches pool providers with fixed placement and executor-only requests", async () => {
  const fixture = await executorFixture()
  const seen: string[] = []
  const executor = new NexusExecutor({
    executor: fixture.client,
    id: "executor",
    storage: fixture.directory,
    root: fixture.directory,
    placement: "fixed",
    roles: ["tool_provider"],
    builtin: false,
    admission: new RunnerAdmission(),
    extensions: () => [
      {
        role: "tool_provider",
        definition: definition("echo", "Echo", {}, []),
        async execute(_, context) {
          seen.push(context.directory)
          expect(context.orchestration).toBeDefined()
          return { content: "pool result" }
        },
      },
    ],
  })
  fixture.add("run", "pool", "echo", {
    addressed_to: { role: "tool_provider", executor_public_id: null, presence: null, last_seen_at: null },
    executor_context: {},
  })
  fixture.add("run", "foreign", "echo", {
    addressed_to: { role: "runner", executor_public_id: "other", presence: null, last_seen_at: null },
  })
  try {
    await executor.sweep()
    await executor.drain()
    expect(seen).toEqual([fixture.directory])
    expect(fixture.commits.map((entry) => entry.task)).toEqual(["pool"])
    expect(fixture.calls.every((call) => call.path.startsWith("/agent_api/v1/executor/"))).toBe(true)
    expect(executor.snapshot().claimed).toBe(1)
  } finally {
    await executor.close()
    await fixture.close()
  }
})

test("reusable executor follows HTTP recovery and closes without a realtime client", async () => {
  const fixture = await executorFixture()
  const committed = Promise.withResolvers<void>()
  fixture.add("run", "task", "echo")
  fixture.control.committed = () => committed.resolve()
  const executor = new NexusExecutor({
    executor: fixture.client,
    id: "executor",
    storage: fixture.directory,
    root: fixture.directory,
    placement: "fixed",
    extensions: () => [
      {
        definition: definition("echo", "Echo", {}, []),
        async execute() {
          return { content: "followed" }
        },
      },
    ],
  })
  try {
    const following = executor.start()
    await committed.promise
    await executor.close()
    await following
    expect(executor.snapshot().running).toBe(false)
  } finally {
    await executor.close()
    await fixture.close()
  }
})

test("worker extensions receive live claim orchestration without credentials", async () => {
  const { ExtensionManager } = await import("../src/extension-manager")
  const { Configuration } = await import("../src/configuration")
  const { workerRegistration } = await import("../src/worker-extension")
  const fixture = await executorFixture()
  const entry = fixture.directory + "/extension.ts"
  await Bun.write(
    entry,
    `export function register(api) {
    api.registerTool({ environmentRequired: false, definition: ${JSON.stringify(definition("worker", "Worker", { tag: { type: "string", pattern: "^allowed$" } }, []))},
      async execute(input, context) {
        if (context.task === "program") return context.orchestration.run({code:"21 * 2"});
        const handle = await context.orchestration.start("worker_op", {kind:"ask",input:{prompt:"Continue?"}});
        return {structured_content: await context.orchestration.wait(handle)};
      }
    });
  }`,
  )
  const manager = new ExtensionManager(
    new Configuration(fixture.directory + "/configuration.json"),
    [
      {
        descriptor: {
          id: "fixture.orchestration",
          name: "Orchestration",
          description: "Fixture",
          default_enabled: true,
          configuration_version: 1,
          configuration_schema: { type: "object" },
          defaults: {},
        },
        register: workerRegistration(entry),
      },
    ],
    fixture.directory,
    new AbortController().signal,
    async () => {},
  )
  const executor = new NexusExecutor({
    executor: fixture.client,
    id: "executor",
    storage: fixture.directory,
    root: fixture.directory,
    placement: "captured",
    extensions: () => manager.tools(),
    hooks: () => manager.captureTools(),
  })
  const observed = { key: "" }
  fixture.control.route = async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/operations")) {
      if (request.method === "GET")
        return Response.json({
          operations: {
            context: {
              tools: [{ name: "code", input_schema: { $id: "urn:opencode:nexus:codemode:1" } }],
              model_defaults: {},
              environment: null,
            },
            trace: [],
            position: 0,
            next_after: null,
          },
        })
      const body = (await request.json()) as { claim_token: string; operation: { key: string; request: object } }
      expect(fixture.claims.get(JSON.stringify(["run", "question"]))).toBe(body.claim_token)
      observed.key = body.operation.key
      return Response.json({
        operation: {
          type: "operation",
          key: observed.key,
          position: 1,
          request: body.operation.request,
          receipt: {},
          refusal: null,
          outcome: null,
        },
      })
    }
    if (path.endsWith("/observation"))
      return Response.json({
        position: 2,
        observation: {
          type: "observation",
          key: observed.key,
          position: 2,
          request: null,
          receipt: null,
          refusal: null,
          outcome: { status: "completed", content: [{ type: "text", text: "Yes" }] },
        },
      })
  }
  fixture.add("run", "question", "worker", { executor_context: {} })
  fixture.add("run", "program", "worker", { executor_context: {} })
  try {
    await manager.start()
    await executor.sweep()
    await executor.drain()
    expect(fixture.commits.find((entry) => entry.task === "question")?.body.structured_content).toMatchObject({
      status: "completed",
      content: [{ type: "text", text: "Yes" }],
    })
    expect(fixture.commits.find((entry) => entry.task === "program")?.body.structured_content).toBe(42)
  } finally {
    await executor.close()
    await manager.close()
    await fixture.close()
  }
})
