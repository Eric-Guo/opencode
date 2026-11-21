import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { conversationFixture, inputFixture } from "./fixture/conversation"
import { RegisteredAgents } from "../src/registered-agents"
import { storeFixture } from "./fixture/store"

test("registered agents inherit the request model and retain ownership across restart and removal", async () => {
  const agents = new Map<string, JsonObject>()
  const declarations: JsonObject[] = []
  const inputs: JsonObject[] = []
  const fault = { loseDeclaration: false }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ answering_user_public_id: "room" }) })
    if (path.endsWith("/principals"))
      return Response.json({ principals: [{ public_id: "room", handle: "room", kind: "agent" }] })
    if (path.endsWith("/workspaces/workspace"))
      return Response.json({
        workspace: {
          public_id: "workspace",
          name: "Dedicated",
          state: "active",
          dedicated: true,
          access_mode: "private",
          lock_version: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {},
          tool_provider_overrides: {},
          owner: { public_id: "human", display_name: "Human" },
          creator: { public_id: "main", display_name: "Main", kind: "agent" },
        },
      })
    if (path.endsWith("/inputs")) {
      const body = (await request.json()) as { input: JsonObject }
      inputs.push(body.input)
      return Response.json({ input: inputFixture(body.input) }, { status: 202 })
    }
    if (!path.includes("/agents")) return
    if (request.method === "GET") return Response.json({ agents: [...agents.values()] })
    const name = path.split("/").at(-1)!
    if (request.method === "DELETE") {
      agents.delete(name)
      return new Response(null, { status: 204 })
    }
    const body = (await request.json()) as JsonObject
    declarations.push(body)
    const agent: JsonObject = {
      ...body,
      public_id: name,
      name,
      display_name: name,
      description: "Shared room",
      scope: "instance",
      derived_from_public_id: "main",
      handle: name,
      agent_identifier: name,
      steward_public_id: "human",
      kind: "agent",
      summarizer: null,
      configuration: {
        tool_definitions: [],
        approval_rules: [],
        approval_mode: "ask",
        prompt_mechanism: "default",
        kernel_tools: [],
        runner_executor_public_ids: [],
        mcp_tools: [],
        fallback_models: [],
        ...(body.configuration as JsonObject),
      },
    }
    agents.set(name, agent)
    if (fault.loseDeclaration) {
      fault.loseDeclaration = false
      return Response.json({ error: { code: "response_lost" } }, { status: 503 })
    }
    return Response.json({ agent })
  })
  const definition = { name: "room", description: "Shared room", system_prompt: "Help", configuration: {} }
  try {
    await new RegisteredAgents(fixture.client).sync(
      [definition],
      { default_model: "provider/default", runner_tool_names: ["read"], compaction_policy: { mode: "kernel" } },
    )
    const application = new NexusApplication(
      fixture.client,
      { agent: "main", runner: "runner", workspace: "workspace" },
      () => ({ default_model: "provider/default" }),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        agents: () => ["room"],
        author: async (draft) => draft,
        follow: async () => undefined,
        bindings: async () => [],
        describeEnvironment: async () => "",
      },
    )
    await application.submit({
      key: "request-model",
      workspace: "workspace",
      conversation: "conversation",
      text: "Help",
      addressed: true,
      answering_user_public_id: "room",
      model: "provider/request",
    })
    await application.submit({
      key: "implicit-model",
      workspace: "workspace",
      conversation: "conversation",
      text: "Help",
      addressed: true,
      answering_user_public_id: "room",
    })
    expect(inputs.map((input) => input.model)).toEqual([{ model: "provider/request" }, { model: "provider/default" }])
    expect(declarations[0]).toMatchObject({
      system_prompt: "Help",
      summarizer: expect.stringContaining("Goal:"),
      configuration: { default_model: null, runner_tool_names: ["read"] },
    })
    await new RegisteredAgents(fixture.client).sync(
      [{ ...definition, configuration: { default_model: "provider/fixed", compaction_policy: { mode: "off" } } }],
      { compaction_policy: { mode: "kernel" } },
    )
    await application.submit({
      key: "fixed-model",
      workspace: "workspace",
      conversation: "conversation",
      text: "Help",
      addressed: true,
      answering_user_public_id: "room",
    })
    expect(inputs[2].model).toBeUndefined()
    expect(declarations[1]).toMatchObject({ configuration: { default_model: "provider/fixed" }, summarizer: null })
    fault.loseDeclaration = true
    await expect(
      new RegisteredAgents(fixture.client).sync([{ ...definition, name: "second-room" }], {}),
    ).rejects.toThrow()
    await new RegisteredAgents(fixture.client).sync([{ ...definition, name: "second-room" }], {})
    expect([...agents.keys()]).toEqual(["second-room"])
    await new RegisteredAgents(fixture.client).sync([], {})
    expect(agents.size).toBe(0)
    expect([...fixture.entries.values()].some((entry) => entry.namespace === "opencode.bots")).toBe(false)
  } finally {
    fixture.server.stop(true)
  }
})
