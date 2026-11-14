import { expect, test } from "bun:test"
import type { AgentConfigurationInput } from "@cybros/agent"
import { applyMcp, matchingNames, mcpCallable, type McpDirectory } from "../src/preset-mcp"
import { externalBot } from "../src/bot-policy"
import { Presets } from "../src/presets"
import { storeFixture } from "./fixture/store"

test("MCP selection uses source identity, preserves ordinary name collisions, and role inheritance intersects both presets", async () => {
  const ref = { source: "executor" as const, executor_public_id: "runner", server_key: "files" }
  const name = mcpCallable(ref, "read")
  const imported = {
    type: "function" as const,
    function: { name, description: "Remote read", parameters: { type: "object" } },
    defer_loading: true,
    route: { kind: "runner" as const, runner_executor_public_id: "runner", tool_name: "served" },
  }
  const ordinary = { type: "function" as const, function: { name, description: "Ordinary tool" } }
  const directory: McpDirectory = [
    {
      ref,
      name: "files",
      account_label: "machine",
      available: true,
      tools: [
        {
          name: "read",
          description: "Remote read",
          input_schema: { type: "object" },
          callable_name: name,
          definition: imported,
        },
      ],
    },
  ]
  const selection = { disabled_connections: [ref], disabled_tools: [] }
  expect(applyMcp({ tool_definitions: [ordinary, imported] }, directory, selection).tool_definitions).toEqual([
    ordinary,
  ])
  expect(matchingNames("mcp__*|a.b", [name, "a.b", "aXb"])).toEqual([name, "a.b"])
  const fixture = storeFixture()
  const presets = new Presets(fixture.client, async () => directory)
  try {
    const catalog = await presets.catalog()
    const base = { default_model: "provider/model", kernel_tools: ["nexus.conversation.spawn"] }
    const all = await presets.resolve(base)
    expect(all.configuration.delegation_catalog[0].inherited_tool_names).toEqual([name])
    expect(all.configuration.delegation_catalog[0].declaration.mcp_tools).toEqual([])
    expect(all.configuration.delegation_catalog[0].declaration.tool_definitions).toEqual([])
    await presets.command({
      action: "preset.replace",
      id: catalog.main_preset_public_id,
      value: { name: "Main", description: "Restricted MCP", configuration: { mcp: selection } },
    })
    const restricted = await presets.resolve(base)
    expect(restricted.configuration.delegation_catalog[0].inherited_tool_names).toEqual([])
  } finally {
    fixture.server.stop(true)
  }
})

test("External Bot policy retains explicit MCP and narrows send/spawn grants, memory and persona", () => {
  const base: AgentConfigurationInput = {
    kernel_tools: [
      "nexus.conversation.send",
      "nexus.conversation.spawn",
      "nexus.memory.read",
      "nexus.schedules.create",
    ],
    tool_definitions: [
      {
        type: "function",
        function: { name: "mcp_read" },
        route: { kind: "runner", runner_executor_public_id: "runner", tool_name: "remote_read" },
      },
      { type: "function", function: { name: "bash" } },
    ],
    approval_mode: "rules",
    approval_rules: [
      { tool: "*", verdict: "allow" },
      { tool: "mcp_danger", verdict: "deny" },
    ],
    runner_tool_names: ["bash"],
    runner_executor_public_ids: ["runner"],
    mcp_tools: [{ connection_public_id: "connection", tool_name: "read", name: "mcp_read" }],
    delegation_catalog: [{ name: "worker", description: "Work" }],
    memory_context_limit: {
      bindings: [
        { name: "conversation", source: { scope: "conversation" }, access: "read" },
        { name: "workspace", source: { scope: "workspace" }, access: "read_write" },
        { name: "user", source: { scope: "user" }, access: "read_write" },
      ],
    },
    prompt_template: { blocks: [{ type: "slot", slot: "persona" }, { type: "memory" }] },
  }
  const result = externalBot(
    base,
    [{ public_id: "peer", handle: "bot-peer", description: "Peer" }],
    { "nexus.conversation.send": "send", "nexus.conversation.spawn": "spawn", "nexus.memory.read": "memory_read" },
    ["mcp_read"],
  )
  expect(result.runner_tool_names).toEqual([])
  expect(result.mcp_tools).toEqual(base.mcp_tools)
  expect(result.approval_rules).toContainEqual({ tool: "mcp_read", verdict: "allow" })
  expect(result.approval_rules).toContainEqual({ tool: "send", path: "agent", match: "peer", verdict: "allow" })
  expect(result.approval_rules).toContainEqual({
    tool: "spawn",
    path: "declaration",
    match: "worker",
    verdict: "allow",
  })
  expect(result.approval_rules.some((rule) => rule.tool === "*")).toBe(false)
  expect(result.kernel_tools).toEqual(["nexus.memory.read"])
  expect(result.tool_definitions).toHaveLength(3)
  expect(result.memory_context_limit.bindings.map((binding) => [binding.name, binding.access])).toEqual([
    ["conversation", "read"],
    ["workspace", "read"],
  ])
  expect(result.prompt_template.blocks).toEqual([{ type: "memory" }])
})
