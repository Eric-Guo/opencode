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
const Provenance = Schema.Struct({ server_key: Schema.String, tool_name: Schema.String })

export async function mcpDirectory(member: Client, agent: string, agentTools: AnnouncedTool[]): Promise<McpDirectory> {
  const directory: McpDirectory = []
  let after: string | undefined
  do {
    const page = await member.mcpConnections.list({ after, limit: 100, agent_public_id: agent })
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
            return { ...tool, callable_name: mcpCallable(ref, tool.name) }
          }),
        }
      }),
    )
    after = page.next_after ?? undefined
  } while (after)
  directory.push(...executorConnections(agent, agentTools, false))
  for (const executor of await member.executors.list({ role: "runner" }))
    directory.push(
      ...executorConnections(executor.public_id, executor.services.runner?.tools ?? [], true, executor.display_name),
    )
  return directory
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
    if (!connection.available || selection?.disabled_connections.some((ref) => isDeepStrictEqual(ref, connection.ref)))
      return []
    return connection.tools
      .filter(
        (tool) =>
          !selection?.disabled_tools.some((ref) => isDeepStrictEqual(ref, { ...connection.ref, tool_name: tool.name })),
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
