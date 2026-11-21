import { expect, test } from "bun:test"
import { client, RequestError, type RequestPermissionResponse } from "@agentclientprotocol/sdk"
import { editorFixture } from "./fixture/editor"
import { conversationFixture } from "./fixture/conversation"

function permissionWorld(
  tool = "web_fetch",
  target: { kind: string; connection_public_id?: string; account_label?: string; tool_name?: string } = {
    kind: "builtin",
  },
) {
  const cancelled = Promise.withResolvers<void>()
  const state = { status: "failed", canceled: false, polls: 0, approvals: 0, denials: 0, cancellations: 0 }
  const task = () => ({
    key: "call",
    kind: "tool_task",
    status: state.status === "running" ? "needs_approval" : state.status,
    lifetime: "foreground",
    wake: "immediate",
    after: [],
    waiting_on: [],
    tool_name: tool,
    target,
    ...(target.kind === "mcp" ? { tool_alias: "work_fetch" } : {}),
    tool_input: { url: "https://docs.example:8443/guide" },
  })
  return {
    state,
    cancelled,
    route(request: Request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/conversations/conversation"))
        return Response.json({ conversation: conversationFixture({ active_turn_public_id: "turn" }) })
      if (path.endsWith("/turns/turn"))
        return Response.json({
          turn: {
            public_id: "turn",
            position: 1,
            kind: "direct_reply",
            role: "assistant",
            status: state.status,
            visibility: "visible",
            created_at: "now",
            answering_user_public_id: "main",
            active_variant: {
              public_id: "variant",
              source: "run",
              status: state.status,
              active: true,
              run_public_id: "run",
            },
          },
        })
      if (path.endsWith("/turns/turn/variants"))
        return Response.json({
          turn: { public_id: "turn" },
          variants: [
            {
              public_id: "variant",
              source: "run",
              status: state.status,
              active: true,
              run_public_id: "run",
              content: "Done",
            },
          ],
        })
      if (path.endsWith("/runs/run")) {
        if (state.canceled && ++state.polls === 3) state.status = "completed"
        return Response.json({
          run: {
            public_id: "run",
            status: state.status === "completed" ? "completed" : "needs_attention",
            tasks: state.status === "completed" ? [] : [task()],
          },
        })
      }
      if (path.endsWith("/tasks/call")) return Response.json({ task: task() })
      if (path.endsWith("/retry")) {
        state.status = "running"
        return Response.json({ task: task() })
      }
      if (path.endsWith("/approve")) {
        state.approvals++
        state.status = "completed"
        return Response.json({ task: task() })
      }
      if (path.endsWith("/deny")) {
        state.denials++
        state.status = "completed"
        return Response.json({ task: task() })
      }
      if (path.endsWith("/cancellation")) {
        state.cancellations++
        cancelled.resolve()
        return new Response(null, { status: 202 })
      }
    },
  }
}

test.each([
  { tool: "web_fetch", target: { kind: "builtin" }, label: "Allow this site until OpenCode restarts" },
  {
    tool: "web_fetch",
    target: { kind: "mcp", connection_public_id: "work", account_label: "Research", tool_name: "web_fetch" },
    label: "Always allow this tool until OpenCode restarts",
  },
  { tool: "bash", target: { kind: "builtin" }, label: "Allow this call's scope until OpenCode restarts" },
])(
  "ACP $tool persistent approval uses the shared owner and reports retention failure",
  async ({ tool, target, label }) => {
    const world = permissionWorld(tool, target)
    const approvals: unknown[] = []
    await using fixture = await editorFixture(
      world.route,
      {
        async approve(input) {
          approvals.push(input)
          world.state.status = "completed"
          return { grant: { refused: "Declaration unavailable" } }
        },
      },
      client().onRequest("session/request_permission", ({ params }) => {
        if (target.kind === "mcp") {
          const first = fixture.updates.find(({ update }) => update.sessionUpdate === "tool_call")
          expect(first?.update).toMatchObject(params.toolCall)
          expect(params.toolCall).toMatchObject({
            title: "work_fetch https://docs.example:8443/guide (work · Research · web_fetch)",
            kind: "other",
            rawInput: { url: "https://docs.example:8443/guide" },
          })
        }
        expect(params.options.find((option) => option.kind === "allow_always")?.name).toBe(label)
        return { outcome: { outcome: "selected", optionId: "always" } }
      }),
    )
    await fixture.attach("session/resume")
    expect(await fixture.prompt("/retry")).toEqual({ stopReason: "end_turn" })
    expect(approvals).toEqual([{ conversation: "conversation", run: "run", task: "call", always: true }])
    expect(world.state.approvals).toBe(0)
    expect(
      fixture.updates.some(
        ({ update }) =>
          (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk") &&
          update.content.type === "text" &&
          update.content.text.includes("The grant could not be saved: Declaration unavailable"),
      ),
    ).toBe(true)
  },
)

test("ACP without a shared grant owner offers only one-time approval", async () => {
  const world = permissionWorld()
  await using fixture = await editorFixture(
    world.route,
    {},
    client().onRequest("session/request_permission", ({ params }) => {
      expect(params.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"])
      return { outcome: { outcome: "selected", optionId: "approve" } }
    }),
  )
  await fixture.attach("session/resume")
  expect(await fixture.prompt("/retry")).toEqual({ stopReason: "end_turn" })
  expect(world.state.approvals).toBe(1)
})

test("ACP permission cancellation leaves the task undecided and does not reopen the card", async () => {
  const world = permissionWorld()
  const cards: string[] = []
  await using fixture = await editorFixture(
    world.route,
    {},
    client().onRequest("session/request_permission", ({ params }) => {
      cards.push(params.toolCall.toolCallId)
      world.state.canceled = true
      return { outcome: { outcome: "cancelled" } }
    }),
  )
  await fixture.attach("session/resume")
  expect(await fixture.prompt("/retry")).toEqual({ stopReason: "end_turn" })
  expect(cards).toEqual(["run:call"])
  expect(world.state.approvals).toBe(0)
  expect(world.state.denials).toBe(0)
})

test("ACP client-aborted permission requests deny the held task", async () => {
  const world = permissionWorld()
  await using fixture = await editorFixture(
    world.route,
    {},
    client().onRequest("session/request_permission", () => {
      throw new RequestError(-32800, "Client cancelled the permission request")
    }),
  )
  await fixture.attach("session/resume")
  expect(await fixture.prompt("/retry")).toEqual({ stopReason: "end_turn" })
  expect(world.state.denials).toBe(1)
  expect(world.state.approvals).toBe(0)
})

test("ACP session cancellation cancels its conversation without deciding a held permission", async () => {
  const world = permissionWorld()
  const asked = Promise.withResolvers<void>()
  const response = Promise.withResolvers<RequestPermissionResponse>()
  await using fixture = await editorFixture(
    world.route,
    {},
    client().onRequest("session/request_permission", ({ signal }) => {
      signal.addEventListener("abort", () => response.resolve({ outcome: { outcome: "cancelled" } }), { once: true })
      asked.resolve()
      return response.promise
    }),
  )
  await fixture.attach("session/resume")
  const prompt = fixture.prompt("/retry")
  await asked.promise
  await fixture.peer.agent.notify("session/cancel", { sessionId: "conversation" })
  expect(await prompt).toEqual({ stopReason: "cancelled" })
  response.resolve({ outcome: { outcome: "cancelled" } })
  expect(world.state.denials).toBe(0)
  expect(world.state.approvals).toBe(0)
  await world.cancelled.promise
  await fixture.peer.agent.request("session/close", { sessionId: "conversation" })
  expect(world.state.cancellations).toBe(1)
})
