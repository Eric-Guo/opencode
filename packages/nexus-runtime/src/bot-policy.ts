import type { AgentConfigurationInput, ApprovalRule, NamedAgent, ToolAlias, ToolDefinition } from "@cybros/agent"
import { Schema } from "effect"
import { matchingNames } from "./preset-mcp"

const kernel = new Set([
  "nexus.memory.read",
  "nexus.memory.write",
  "nexus.memory.edit",
  "nexus.memory.ls",
  "nexus.memory.grep",
  "nexus.memory.delete",
  "nexus.skill.load",
  "nexus.tools.search",
  "nexus.tools.call",
  "nexus.models.list",
  "nexus.human.ask",
  "nexus.graph.delegate_task",
  "nexus.graph.wait",
  "nexus.conversation.spawn",
  "nexus.conversation.send",
  "nexus.conversation.request",
  "nexus.conversation.links",
  "nexus.conversation.status",
  "nexus.conversation.cancel",
  "nexus.conversation.search",
  "nexus.conversation.read",
])
const delegation = new Set(["nexus.conversation.spawn", "nexus.conversation.send", "nexus.conversation.request"])
const Definition = Schema.Struct({
  canonical: Schema.optional(Schema.String),
  function: Schema.optional(Schema.Struct({ name: Schema.String })),
  name: Schema.optional(Schema.String),
  route: Schema.optional(Schema.Struct({ tool_name: Schema.String })),
})
const Template = Schema.Struct({
  blocks: Schema.mutable(Schema.Array(Schema.Record(Schema.String, Schema.MutableJson))),
})

/** External audiences retain explicit MCP and peer/role capabilities, with kernel-enforced argument rules. */
export function externalBot(
  base: AgentConfigurationInput,
  peers: Pick<NamedAgent, "public_id" | "handle" | "description">[],
  wire: Record<string, string>,
  mcp: readonly string[],
) {
  const kernels = (base.kernel_tools ?? []).filter((name) => kernel.has(name))
  const definitions = (base.tool_definitions ?? []).map((raw) => ({
    raw,
    ...Schema.decodeUnknownSync(Definition)(raw),
  }))
  const roles = (base.delegation_catalog ?? []).map((value) =>
    Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String, description: Schema.String }))(value),
  )
  const aliases = definitions
    .filter((entry) => entry.canonical && kernel.has(entry.canonical))
    .map((entry) => entry.raw as ToolAlias)
    .concat(
      kernels
        .filter((name) => delegation.has(name))
        .map((canonical) => ({ type: "function", function: { name: wire[canonical] ?? canonical }, canonical })),
    )
    .map((entry) => destinations(entry, peers, roles))
  const declared = [...new Set([...kernels, ...aliases.map((entry) => entry.canonical)])]
  const names = (canonical: string) => [
    ...new Set([
      wire[canonical] ?? canonical,
      ...aliases.filter((entry) => entry.canonical === canonical).map((entry) => entry.function.name),
    ]),
  ]
  const ordinary = declared.filter((name) => !delegation.has(name)).flatMap(names)
  const rules: ApprovalRule[] = [
    ...(base.approval_rules ?? []).filter((rule) => rule.verdict === "ask" || rule.verdict === "deny"),
    ...mcpRules(base, definitions, mcp),
    ...(ordinary.length ? [{ tool: ordinary.join("|"), verdict: "allow" as const }] : []),
    ...declared
      .filter((name) => name === "nexus.conversation.send" || name === "nexus.conversation.request")
      .flatMap((name) =>
        peers.map((peer) => ({
          tool: names(name).join("|"),
          path: "agent",
          match: peer.public_id,
          verdict: "allow" as const,
        })),
      ),
    ...(declared.includes("nexus.conversation.send")
      ? [
          {
            tool: names("nexus.conversation.send").join("|"),
            path: "link_public_id",
            match: "*",
            verdict: "allow" as const,
          },
        ]
      : []),
    ...(declared.includes("nexus.conversation.spawn")
      ? roles.map((role) => ({
          tool: names("nexus.conversation.spawn").join("|"),
          path: "declaration",
          match: role.name,
          verdict: "allow" as const,
        }))
      : []),
  ]
  const ceiling = { conversation: "read_write", speaker: "read_write", workspace: "read" } as const
  const bindings =
    base.memory_context_limit?.bindings ??
    (["conversation", "speaker", "workspace"] as const).map((name) => ({
      name,
      source: { scope: name },
      access: ceiling[name],
    }))
  const template =
    base.prompt_template == null
      ? {
          blocks: [
            { type: "slot", slot: "system_prompt" },
            { type: "slot", slot: "character" },
            { type: "memory" },
            { type: "history" },
            { type: "skills" },
            { type: "input" },
          ],
        }
      : Schema.decodeUnknownSync(Template)(base.prompt_template)
  return {
    ...base,
    kernel_tools: kernels.filter((name) => !delegation.has(name)),
    tool_definitions: [
      ...aliases,
      ...definitions
        .filter((entry) => mcp.includes(entry.function?.name ?? entry.name ?? ""))
        .map((entry) => entry.raw),
    ],
    runner_executor_public_ids: [],
    runner_tool_names: [],
    approval_mode: "rules" as const,
    approval_rules: rules,
    conversation_reach: "subtree",
    prompt_mechanism: "assembly" as const,
    prompt_template: {
      ...template,
      blocks: template.blocks.filter((block) => !(block.type === "slot" && block.slot === "persona")),
    },
    memory_context_limit: {
      bindings: bindings.flatMap((binding) => {
        const access = ceiling[binding.source.scope as keyof typeof ceiling]
        return access
          ? [
              {
                ...binding,
                access: binding.access === "read" || access === "read" ? ("read" as const) : ("read_write" as const),
              },
            ]
          : []
      }),
    },
  } satisfies AgentConfigurationInput
}

function destinations(
  entry: ToolAlias,
  peers: Pick<NamedAgent, "public_id" | "handle" | "description">[],
  roles: { name: string; description: string }[],
): ToolAlias {
  if (!delegation.has(entry.canonical)) return entry
  const spawn = entry.canonical === "nexus.conversation.spawn"
  const field = spawn ? "declaration" : "agent"
  const params = Object.fromEntries(
    Object.entries(entry.params ?? {}).filter(([name, spec]) => !spawn || (spec.maps_to ?? name) !== "agent"),
  )
  const name = Object.entries(params).find(([, spec]) => spec.maps_to === field)?.[0] ?? field
  const description = spawn
    ? "Required. Choose one exact Subagent role:\n" +
      roles.map((role) => "- " + role.name + ": " + role.description).join("\n")
    : "Pass one exact Bot UUID; do not use an @handle:\n" +
      peers.map((peer) => "- " + peer.public_id + " (" + peer.handle + "): " + peer.description).join("\n") +
      (entry.canonical === "nexus.conversation.send"
        ? "\nFor a granted link, omit agent and to and pass link_public_id."
        : "")
  return {
    ...entry,
    params: { ...params, [name]: { maps_to: field, description } },
    omit: [...new Set([...(entry.omit ?? []), ...(spawn ? ["agent"] : [])])].filter((name) => name !== field),
  }
}

function mcpRules(
  base: AgentConfigurationInput,
  definitions: { raw: ToolDefinition; function?: { name: string }; route?: { tool_name: string } }[],
  names: readonly string[],
): ApprovalRule[] {
  if (!names.length) return []
  if (base.approval_mode !== "rules")
    return [{ tool: names.join("|"), verdict: base.approval_mode === "ask" ? "ask" : "allow" }]
  return (base.approval_rules ?? []).flatMap((rule) => {
    if (rule.verdict !== "allow") return []
    const served = definitions
      .filter(
        (entry) =>
          entry.route &&
          entry.function &&
          names.includes(entry.function.name) &&
          matchingNames(rule.tool, [entry.route.tool_name]).length,
      )
      .map((entry) => entry.function!.name)
    const selected = [...new Set([...matchingNames(rule.tool, names), ...served])]
    return selected.length ? [{ ...rule, tool: selected.join("|") }] : []
  })
}

export function externalRoles(
  configuration: AgentConfigurationInput,
  peers: Pick<NamedAgent, "public_id" | "handle" | "description">[],
  wire: Record<string, string>,
) {
  return (configuration.delegation_catalog ?? []).map((value) => {
    const entry = Schema.decodeUnknownSync(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        model_mode: Schema.String,
        inherited_tool_names: Schema.mutable(Schema.Array(Schema.String)),
        declaration: Schema.Record(Schema.String, Schema.MutableJson),
      }),
    )(value)
    const declaration = externalBot(
      entry.declaration as AgentConfigurationInput,
      peers,
      wire,
      entry.inherited_tool_names,
    )
    return {
      ...entry,
      declaration: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
        JSON.stringify(declaration),
      ),
    }
  })
}
