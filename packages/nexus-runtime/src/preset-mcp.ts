import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import type {
  AgentConfigurationInput,
  AnnouncedTool,
  Client,
  JsonObject,
  ToolDefinition,
  ServedTool,
} from "@cybros/agent"
import type { NexusPreset } from "@opencode/schema/nexus-preset"

type Reference =
  | { source: "nexus"; connection_public_id: string }
  | { source: "executor"; executor_public_id: string; server_key: string }
export type McpDirectory = Array<{
  ref: Reference
  previous_ref?: Reference
  name: string
  account_label: string | null
  available: boolean
  tools: Array<{
    name: string
    description: string
    input_schema: JsonObject
    callable_name: string
    definition?: ToolDefinition
  }>
}>
const Remote = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: Schema.Record(Schema.String, Schema.MutableJson),
})
const Choice = Schema.Struct({
  name: Schema.optional(Schema.String),
  canonical: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  function: Schema.optional(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })),
})
export type PresetInventory = Awaited<ReturnType<typeof presetInventory>>
const Provenance = Schema.Struct({ server_key: Schema.String, tool_name: Schema.String })

export async function presetInventory(
  member: Client,
  identity: { agent: string; runner: string },
  agentTools: AnnouncedTool[],
  base: AgentConfigurationInput,
) {
  const [kernel, executors] = await Promise.all([member.tools.list(), member.executors.list({ role: "runner" })])
  const candidates = executors.filter((row) => base.runner_executor_public_ids?.includes(row.public_id))
  const directory: McpDirectory = []
  let after: string | undefined
  do {
    const page = await member.mcpConnections.list({ after, limit: 100, agent_public_id: identity.agent })
    directory.push(
      ...page.items.map((connection) => {
        const ref = { source: "nexus" as const, connection_public_id: connection.public_id }
        return {
          ref,
          name: connection.name,
          account_label: connection.account_label,
          available: connection.available,
          tools: connection.tools.map((value) => {
            const tool = Schema.decodeUnknownSync(Remote)(value)
            const imported = base.mcp_tools?.find(
              (entry) => entry.connection_public_id === connection.public_id && entry.tool_name === tool.name,
            )
            return { ...tool, callable_name: imported?.name ?? mcpCallable(ref, tool.name) }
          }),
        }
      }),
    )
    after = page.next_after ?? undefined
  } while (after)
  for (const row of executorConnections(identity.runner, agentTools, false)) {
    directory.push({
      ...row,
      previous_ref: { source: "executor", executor_public_id: identity.agent, server_key: row.name },
    })
  }
  for (const executor of candidates)
    directory.push(
      ...executorConnections(executor.public_id, executor.services.runner?.tools ?? [], true, executor.display_name),
    )
  const tools = new Map<string, NexusPreset.ToolChoices["tools"][number]>()
  for (const tool of kernel.filter((tool) => base.kernel_tools?.includes(tool.canonical_name))) {
    tools.set(tool.name, {
      name: tool.name,
      canonical: tool.canonical_name,
      kind: "kernel",
      ...(tool.template && { description: tool.template }),
    })
  }
  for (const entry of withoutMcp(base.tool_definitions ?? [], directory)) {
    const tool = Schema.decodeUnknownSync(Choice)(entry)
    const name = tool.function?.name ?? tool.name
    if (!name) continue
    const description = tool.description ?? tool.function?.description ?? tools.get(name)?.description
    tools.set(name, {
      name,
      ...(tool.canonical && { canonical: tool.canonical }),
      kind: tool.canonical ? "kernel" : "agent",
      ...(description && { description }),
    })
  }
  const runners = new Map<string, NexusPreset.ToolChoices["tools"][number]>()
  for (const tool of candidates.flatMap((row) => row.services.runner?.tools ?? [])) {
    if (
      !tool.mcp &&
      tool.description &&
      tool.input_schema &&
      (base.runner_tool_names == null || base.runner_tool_names.includes(tool.name))
    )
      runners.set(tool.name, { name: tool.name, kind: "runner", description: tool.description })
  }
  return { directory, tools: [...tools.values(), ...runners.values()], kernel }
}

function executorConnections(
  id: string,
  tools: readonly (
    | Pick<AnnouncedTool, "name" | "description" | "input_schema" | "mcp" | "effect_profile">
    | ServedTool
  )[],
  runner: boolean,
  label: string | null = null,
) {
  const connections = new Map<string, McpDirectory[number]>()
  for (const tool of tools) {
    if (!tool.mcp || !tool.description || !tool.input_schema) continue
    const provenance = Schema.decodeUnknownSync(Provenance)(tool.mcp)
    const ref = { source: "executor" as const, executor_public_id: id, server_key: provenance.server_key }
    const name = runner ? mcpCallable(ref, provenance.tool_name) : tool.name
    const connection = connections.get(ref.server_key) ?? {
      ref,
      name: ref.server_key,
      account_label: label,
      available: true,
      tools: [],
    }
    connection.tools.push({
      name: provenance.tool_name,
      description: tool.description,
      input_schema: tool.input_schema,
      callable_name: name,
      definition: {
        type: "function",
        function: { name, description: tool.description, parameters: tool.input_schema },
        defer_loading: true,
        ...(tool.effect_profile ? { effect_profile: { ...tool.effect_profile } } : {}),
        ...(runner ? { route: { kind: "runner", runner_executor_public_id: id, tool_name: tool.name } } : {}),
      },
    })
    connections.set(ref.server_key, connection)
  }
  return [...connections.values()]
}

export function mcpCallable(reference: Reference, name: string) {
  const identity =
    Object.entries(reference)
      .sort(([a], [b]) => a.localeCompare(b))
      .flat()
      .join("\0") +
    "\0" +
    name
  const label = (("server_key" in reference ? reference.server_key : "nexus") + "__" + name)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 45)
  return "mcp__" + label + "__" + createHash("sha256").update(identity).digest("hex").slice(0, 12)
}

export function selectedMcp(directory: McpDirectory, selection?: NexusPreset.Configuration["mcp"]) {
  return directory.flatMap((connection) => {
    const references = connection.previous_ref ? [connection.ref, connection.previous_ref] : [connection.ref]
    if (
      !connection.available ||
      selection?.disabled_connections.some((ref) => references.some((value) => isDeepStrictEqual(ref, value)))
    )
      return []
    return connection.tools
      .filter(
        (tool) =>
          !selection?.disabled_tools.some((ref) =>
            references.some((value) => isDeepStrictEqual(ref, { ...value, tool_name: tool.name })),
          ),
      )
      .map((tool) => ({ ref: connection.ref, tool }))
  })
}

export function withoutMcp(definitions: ToolDefinition[], directory: McpDirectory) {
  const imports = directory.flatMap((connection) =>
    connection.tools.flatMap((tool) => (tool.definition ? [tool.definition] : [])),
  )
  const comparable = (entry: ToolDefinition) =>
    Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "defer_loading"))
  return definitions.filter(
    (entry) => !imports.some((imported) => isDeepStrictEqual(comparable(imported), comparable(entry))),
  )
}

export function applyMcp(
  configuration: AgentConfigurationInput,
  directory: McpDirectory,
  selection?: NexusPreset.Configuration["mcp"],
) {
  const selected = selectedMcp(directory, selection)
  return {
    ...configuration,
    tool_definitions: [
      ...withoutMcp(configuration.tool_definitions ?? [], directory),
      ...selected.flatMap((entry) => (entry.tool.definition ? [entry.tool.definition] : [])),
    ],
    mcp_tools: selected.flatMap((entry) =>
      entry.ref.source === "nexus"
        ? [
            {
              connection_public_id: entry.ref.connection_public_id,
              tool_name: entry.tool.name,
              name: entry.tool.callable_name,
            },
          ]
        : [],
    ),
  }
}

export function matchingNames(pattern: string, names: readonly string[]) {
  const patterns = pattern.split("|").map(
    (word) =>
      new RegExp(
        "^" +
          word
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
        "s",
      ),
  )
  return names.filter((name) => patterns.some((expression) => expression.test(name)))
}
