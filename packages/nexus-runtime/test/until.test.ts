import { expect, test } from "bun:test"
import { Client, type JsonObject, type Run, type Task, type TaskDetail } from "@cybros/agent"
import { Until, UntilGate, untilKey, untilPolicy, untilSteps, untilVerdict } from "../src/until"

import { storeFixture } from "./fixture/store"

const policy = untilPolicy({
  command: "bun test",
  attempts: 3,
  directory: "/project",
  runner: "runner",
  seed: {
    model: { model: "test/model" },
    tools: [],
    executor_contexts: { runner: { "opencode.directory": "/project" } },
    instructions: "complete the requested work",
  },
})
function task(key: string, kind: string, status: string): Task {
  return {
    key,
    kind,
    status,
    lifetime: "conversation",
    wake: "auto",
    after: [],
    waiting_on: [],
    on_failure: null,
    failure_resolution: null,
    tool_name: null,
    tool_alias: null,
    result: null,
    error: null,
    visibility: null,
    created_at: null,
    started_at: null,
    completed_at: null,
    model: null,
    workload: null,
    result_delivered_at: null,
    addressed_to: null,
    target: null,
    claimed_by: null,
    approval: null,
  }
}
function trace(): Run {
  return {
    public_id: "run",
    workspace_public_id: "workspace",
    status: "running",
    failure_reason: null,
    deliverable_task_key: "hold-1",
    tasks: [
      task("r1", "model_task", "completed"),
      task("check-1", "tool_task", "completed"),
      task("hold-1", "await_task", "dispatched"),
    ],
    task_progress: {
      total: 3,
      waiting: 0,
      needs_approval: 0,
      running: 0,
      dispatched: 1,
      awaiting_input: 0,
      completed: 2,
      failed: 0,
      canceled: 0,
      timed_out: 0,
      uncertain: 0,
      skipped: 0,
    },
    attention: null,
    turn: null,
    input_queue: null,
    started_at: null,
    paused_at: null,
    completed_at: null,
    details_pruned_at: null,
    created_at: null,
    updated_at: null,
    default_runner: null,
    prompt_mechanism: null,
    approval_mode: null,
    runner_effects: null,
    model_selection: null,
    fallback_models: null,
    requester_speaker_public_id: null,
  }
}
function detail(exit: number | null, output = "failed test output"): TaskDetail {
  return {
    task: task("check-1", "tool_task", "completed"),
    executor_context: policy.seed.executor_contexts.runner,
    model_selection: null,
    fallback_models: null,
    declaring_task_key: null,
    output,
    output_preview: null,
    content: null,
    structured_content: exit === null ? null : { exit_status: exit },
    prompt: null,
    options: null,
    multi: null,
    fields: null,
    tool_input: null,
    effect_profile: null,
    request_bytes: null,
    instructions: null,
    tool_definitions: null,
    title: null,
    metadata: null,
    wait: null,
  }
}

function fixture(row: TaskDetail) {
  const run = trace()
  const calls: string[] = []
  const appends: { key: string | null; body: JsonObject }[] = []
  const state = { conflict: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push(request.method + " " + path)
      if (request.method === "GET" && path.endsWith("/tasks/check-1"))
        return Response.json({ task: { ...row, ...row.task } })
      if (request.method === "GET" && path.endsWith("/runs/run")) return Response.json({ run })
      if (request.method === "POST" && path.endsWith("/tasks")) {
        const body = (await request.json()) as JsonObject
        appends.push({ key: request.headers.get("Idempotency-Key"), body })
        if (state.conflict)
          return Response.json({ error: { code: "trace_changed", message: "trace changed" } }, { status: 409 })
        return Response.json({
          receipt: {
            accepted_task_keys: [],
            steps: body.steps,
            deliverable_task_key: null,
            revision: 1,
            resolution_tokens: {},
            replayed: false,
          },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    run,
    row,
    calls,
    appends,
    state,
    server,
    context: new Client({ baseURL: server.url.origin, credential: "fixture" }).workspace("workspace").run("run"),
  }
}

test("Until graph readiness waits for parked holds and all business work, including child reports", () => {
  const gate = new UntilGate(policy, "run")
  expect(gate.ready(trace())).toBe(1)
  for (const status of ["waiting", "completed", "canceled", "failed"]) {
    const run = trace()
    run.tasks[2].status = status
    expect(gate.ready(run)).toBeUndefined()
  }
  for (const kind of ["model_task", "tool_task", "delegation_task"]) {
    const run = trace()
    run.tasks.push(task("pending", kind, "waiting"))
    expect(gate.ready(run)).toBeUndefined()
  }
  const planted = trace()
  planted.tasks.push(task("work-2", "model_task", "waiting"))
  expect(gate.ready(planted)).toBeUndefined()
  expect(gate.ready({ ...trace(), public_id: "other" })).toBeUndefined()
  expect(
    gate.ready({ ...trace(), attention: { reason: "ask", blocked_task_keys: [], blocked_task_overflow: null } }),
  ).toBeUndefined()
  expect(untilKey("run", 1)).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  expect(untilKey("run", 1)).not.toBe(untilKey("run", 1, "release"))
  expect(untilSteps(policy)[0]).toMatchObject({
    tool: {
      key: "check-1",
      name: "bash",
      executor_context: policy.seed.executor_contexts.runner,
      on_failure: "absorb",
      timeout_ms: 600000,
      input: { timeout: 120 },
    },
  })
  expect(untilSteps(policy)[1]).toMatchObject({ ask: { key: "hold-1", indefinite: true } })
})

test.each([
  { exit: 0, output: "all passed", next: "summary", count: 1, done: true },
  { exit: 1, output: "tests failed", next: "work-2", count: 3, done: false },
  { exit: null, output: "Command timed out", next: "work-2", count: 3, done: false },
  { exit: null, output: "Cannot start command", next: "report", count: 1, done: true },
])("Until records settled verdict $output with atomic successor and hold resolution", async (value) => {
  const server = fixture(detail(value.exit, value.output))
  const gate = new UntilGate(policy, "run", 60)
  try {
    await Promise.all([gate.reconsider(server.context), gate.reconsider(server.context)])
    expect(server.appends).toHaveLength(1)
    expect(server.calls.filter((call) => call.endsWith("/tasks/check-1"))).toHaveLength(1)
    expect(server.appends[0].body.resolve).toMatchObject([{ task: "hold-1" }])
    const steps = server.appends[0].body.steps as JsonObject[]
    expect(steps).toHaveLength(value.count)
    expect(steps[0].model).toMatchObject({
      key: value.next,
      results: ["check-1", "hold-1"],
      model: policy.seed.model,
      executor_contexts: policy.seed.executor_contexts,
    })
    expect(gate.done).toBe(value.done)
    if (value.count === 3)
      expect(steps[1].tool).toMatchObject({
        key: "check-2",
        input: { command: "bun test", workdir: "/project", timeout: 60 },
      })
    expect(untilVerdict(server.row).passed).toBe(value.exit === 0)
  } finally {
    server.server.stop(true)
  }
})

test("Until leaves moved traces for later recovery and preserves its append identity", async () => {
  const server = fixture(detail(1))
  const gate = new UntilGate(policy, "run")
  try {
    server.state.conflict = true
    await gate.reconsider(server.context)
    expect(gate.done).toBe(false)
    server.state.conflict = false
    await new UntilGate(policy, "run").reconsider(server.context)
    expect(server.appends).toHaveLength(2)
    expect(server.appends[0]).toEqual(server.appends[1])
    server.run.status = "canceled"
    await gate.reconsider(server.context)
    expect(gate.done).toBe(true)
    expect(server.appends).toHaveLength(2)
  } finally {
    server.server.stop(true)
  }
})

test("Until restart recovery proves the original materialization and scans past empty pages", async () => {
  const run = trace()
  run.turn = {
    public_id: "turn",
    conversation_public_id: "conversation",
    answering_user_public_id: "owner",
    status: "running",
    failure_reason_key: null,
    model: null,
  }
  const row = detail(0)
  row.task.tool_name = "bash"
  row.task.target = {
    executor_public_id: "runner",
    display_name: null,
    kind: "runner",
    connection_public_id: null,
    account_label: null,
    tool_name: "bash",
  }
  row.tool_input = { command: policy.command, workdir: policy.directory }
  const candidate = {
    public_id: "run",
    workspace_public_id: "workspace",
    conversation_public_id: "conversation",
    turn_public_id: "turn",
    status: "running",
  }
  const state = { original: "unrelated", appended: 0 }
  const cursors: (string | null)[] = []
  const fixture = storeFixture(async (request) => {
    const url = new URL(request.url)
    const path = url.pathname
    if (path.endsWith("/run_candidates")) {
      cursors.push(url.searchParams.get("after"))
      return Response.json({
        runs: url.searchParams.has("after") ? [candidate] : [],
        pagination: { next_after: url.searchParams.has("after") ? null : "next" },
      })
    }
    if (path.endsWith("/runs/run")) return Response.json({ run })
    if (path.endsWith("/tasks/check-1")) return Response.json({ task: { ...row, ...row.task } })
    if (path.endsWith("/turns/turn"))
      return Response.json({
        turn: {
          public_id: "turn",
          input_public_id: "input",
          position: 0,
          kind: "assistant",
          role: "assistant",
          status: "running",
          visibility: "visible",
          created_at: "2026-01-01T00:00:00Z",
          answering_user_public_id: "owner",
        },
      })
    if (path.endsWith("/inputs/input/materialization"))
      return Response.json({
        materialization: {
          input_public_id: "input",
          turn_public_id: "turn",
          variant_public_id: "variant",
          run_public_id: state.original,
        },
      })
    if (path.endsWith("/tasks") && request.method === "POST") {
      state.appended++
      return Response.json({
        receipt: {
          accepted_task_keys: [],
          steps: [],
          deliverable_task_key: "summary",
          revision: 1,
          resolution_tokens: {},
          replayed: false,
        },
      })
    }
  })
  try {
    const service = new Until(fixture.client, "owner")
    await service.prepare("workspace", "conversation", policy)
    await service.recover(candidate)
    expect(state.appended).toBe(0)
    state.original = "run"
    const restarted = new Until(fixture.client, "owner")
    await restarted.scan(["owner", "owner"], new AbortController().signal)
    expect(cursors).toEqual([null, "next"])
    expect(state.appended).toBe(1)
    expect([...fixture.entries.values()][0].value).toMatchObject({ run: "run", owner: "owner" })
    expect(await new Until(fixture.client, "another-owner").recover(candidate)).toBeUndefined()
    expect(await restarted.recover({ ...candidate, public_id: "different-run" })).toBeUndefined()
    expect(state.appended).toBe(1)
    const recovered = new Until(fixture.client, "owner")
    run.tasks = [
      ...run.tasks,
      { ...run.tasks.find((task) => task.key === "check-1")!, key: "check-2", status: "waiting" },
    ]
    run.attention = { reason: "needs_approval", blocked_task_keys: ["check-2"], blocked_task_overflow: null }
    await recovered.recover(candidate)
    expect(recovered.progress("workspace", run)).toEqual({ checks: 1, attempts: policy.attempts })
    expect(recovered.progress("other", run)).toBeNull()
  } finally {
    fixture.server.stop(true)
  }
})

test("new Until plans read the current shell timeout without rewriting an earlier plan", () => {
  const fixture = storeFixture()
  const settings = { timeout: 42 }
  const until = new Until(fixture.client, "agent", () => settings.timeout)
  try {
    const first = until.plan(policy)
    settings.timeout = 60
    expect(first.steps[0]).toMatchObject({ tool: { input: { timeout: 42 } } })
    expect(until.plan(policy).steps[0]).toMatchObject({ tool: { input: { timeout: 60 } } })
  } finally {
    fixture.server.stop(true)
  }
})
