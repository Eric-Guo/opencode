import { expect, test } from "bun:test"
import { runPrompt } from "../src/run"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

for (const scenario of [
  "completed",
  "failed",
  "canceled",
  "blocked",
  "pending",
  "hold",
  "ask",
  "approval",
  "addressed",
  "running-approval",
  "running-ask",
])
  test("one-shot run correlates its input and returns " + scenario, async () => {
    const status =
      scenario === "addressed" ? "completed" : scenario.startsWith("running-") ? scenario.slice(8) : scenario
    const conversation = conversationFixture(scenario === "addressed" ? { answering_user_public_id: "peer" } : {})
    const control = { canceled: 0, denied: 0 }
    const task = {
      key: "decision",
      kind: "tool",
      status: status === "ask" ? "awaiting_input" : "needs_approval",
      lifetime: "turn",
      wake: "auto",
      after: [],
      waiting_on: [],
      addressed_to: {},
      approval: null,
    }
    const fixture = storeFixture(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/principals"))
        return Response.json({
          principals: [{ public_id: "peer", kind: "agent", handle: "peer", display_name: "Peer" }],
        })
      if (path.endsWith("/workspaces/workspace"))
        return Response.json({
          workspace: {
            public_id: "workspace",
            name: "Workspace",
            dedicated: false,
            access_mode: "private",
            state: "active",
            lock_version: 0,
            archived_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: {},
            tool_provider_overrides: {},
            owner: { public_id: "human", display_name: "Human" },
            creator: { public_id: "main", display_name: "Main", kind: "agent" },
          },
        })
      if (path.endsWith("/profile/agents")) return Response.json({ agents: [] })
      if (path.endsWith("/conversations") && request.method === "POST")
        return Response.json({ conversation }, { status: 201 })
      if (path.endsWith("/conversations/conversation")) return Response.json({ conversation })
      if (path.endsWith("/executors")) return Response.json({ executors: [] })
      if (path.endsWith("/inputs") && request.method === "POST") {
        const body = (await request.json()) as { input: Record<string, unknown> }
        expect(body.input).not.toHaveProperty("instructions")
        if (scenario === "addressed") {
          expect(body.input.answering_user_public_id).toBe("peer")
          expect(body.input).not.toHaveProperty("agent_configuration")
        }
        return Response.json({ input: inputFixture() }, { status: 202 })
      }
      if (path.endsWith("/events"))
        return Response.json({
          events:
            status === "blocked"
              ? [
                  {
                    type: "input_blocked",
                    sequence: 1,
                    public_id: "event",
                    payload: { input_public_id: "input", blocked_reason: "unknown_model" },
                  },
                ]
              : [],
          pagination: { next_after: null, watermark: status === "blocked" ? 1 : 0 },
        })
      if (path.endsWith("/materialization"))
        return status === "pending" || status === "blocked"
          ? Response.json({ error: { code: "not_found" } }, { status: 404 })
          : Response.json({
              materialization: {
                input_public_id: "input",
                turn_public_id: "own",
                variant_public_id: "first",
                run_public_id: "run",
              },
            })
      if (path.endsWith("/variants"))
        return Response.json({
          turn: { public_id: "own", inherited: false },
          variants: [
            {
              public_id: "unrelated",
              source: "regenerate",
              status: "completed",
              content: "Wrong answer",
              run_public_id: "wrong",
            },
            {
              public_id: "first",
              source: "original",
              status: control.denied
                ? "completed"
                : status === "hold"
                  ? "failed"
                  : ["ask", "approval"].includes(status)
                    ? "running"
                    : status,
              content: "Own answer",
              run_public_id: "run",
            },
          ],
        })
      if (path.endsWith("/runs/run"))
        return Response.json({
          run: {
            public_id: "run",
            status:
              control.denied || status === "failed"
                ? "completed"
                : ["ask", "approval"].includes(status)
                  ? "needs_attention"
                  : "running",
            ...(scenario.startsWith("running-") && !control.denied
              ? {
                  status: "running",
                  attention: {
                    reason: status === "ask" ? "awaiting_input" : "approval_required",
                    blocked_task_keys: [],
                  },
                }
              : {}),
            tasks: ["ask", "approval"].includes(status) && !control.denied ? [task] : [],
          },
        })
      if (path.endsWith("/tasks/decision"))
        return Response.json({ task: { ...task, output: null, content: null, structured_content: null } })
      if (path.endsWith("/deny")) {
        control.denied++
        return Response.json({ task })
      }
      if (path.endsWith("/cancellation")) {
        control.canceled++
        return new Response(null, { status: 202 })
      }
    })
    const app = new NexusApplication(
      fixture.client,
      { agent: "main", runner: "runner", workspace: "workspace" },
      () => ({}),
      undefined,
      async () => ({ agent_configuration: {}, model: "lane/model", fallback_models: [], tools: [] }),
    )
    try {
      const events = await Array.fromAsync(
        runPrompt(
          app,
          {
            key: "key",
            prompt: "Do work",
            ...(scenario === "addressed" ? { agent: "peer" } : {}),
            ...(status === "pending" ? { timeout_ms: 30 } : {}),
          },
          new AbortController().signal,
        ),
      )
      const result = events.at(-1)!
      expect(result).toMatchObject({
        type: "result",
        exit_status: ["completed", "approval"].includes(status)
          ? 0
          : ["pending", "hold", "ask"].includes(status)
            ? 2
            : 1,
      })
      if (status === "completed") expect(result.result).toBe("Own answer")
      if (status === "approval") expect(result.denied_calls).toBe(1)
      if (status === "ask" || status === "hold") expect(control.canceled).toBe(1)
      if (status === "pending") {
        expect(result.reason).toBe("timeout")
        expect(control.canceled).toBeGreaterThan(0)
      }
    } finally {
      fixture.server.stop(true)
      await app.titles.close()
    }
  })

test("one-shot output reconciles live deltas with durable snapshots and keeps JSON output self-contained", async () => {
  const { RunOutput } = await import("../src/run")
  const chunks: string[] = []
  const output = new RunOutput({
    format: "text",
    print: false,
    write: (text) => {
      chunks.push(text)
    },
    error: () => {},
  })
  output.accept({ type: "transcript", frame: { type: "text_delta", payload: { text: "Hello" } } })
  output.accept({ type: "snapshot", content: "Hello world" })
  expect(output.accept({ type: "result", result: "Hello world", exit_status: 0 })).toBe(0)
  expect(chunks.join("")).toBe("Hello world\n")
  const json: string[] = []
  const structured = new RunOutput({
    format: "json",
    print: false,
    write: (text) => {
      json.push(text)
    },
    error: () => {
      throw new Error("Structured output has no second error channel")
    },
  })
  structured.accept({ type: "snapshot", content: "partial" })
  structured.accept({ type: "result", result: null, reason: "unknown_model", exit_status: 1 })
  expect(json.map((line) => JSON.parse(line))).toEqual([
    { type: "result", result: null, reason: "unknown_model", exit_status: 1 },
  ])
})
