import { APIError, type Client, type AgentConfigurationInput } from "@cybros/agent"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { NexusPreset } from "@opencode/schema/nexus-preset"
import { StoreDocument } from "./document"

export const guidance =
  "Complete the requested work using the available tools and verify the result. Accepted work retains its captured environment, tools and model policy. Discover capabilities before calling them. Deliver results to their original requester. Save useful confirmed facts through the available memory tools and claim saved changes only after successful tool results."

const seeds = [
  {
    name: "Probius",
    description: "Work with the owner on coding, research and practical tasks.",
    prompt:
      "Complete the user's task. Inspect relevant context, make requested changes, and verify the result. Delegate bounded work with an explicit brief. Report outcomes, evidence and remaining limits.",
  },
  {
    name: "Adjutant",
    description: "Help people through a connected chat and coordinate delegated work.",
    prompt:
      "Help the person in this chat with concise, useful replies. Complete authorized tasks and delegate substantial work with a clear brief. Respect this Bot's audience, tools and conversation boundaries.",
  },
  {
    name: "worker",
    description: "Carry out a bounded task or an implementation plan.",
    prompt:
      "Complete the supplied task or plan within its scope. Inspect relevant evidence, implement the requested changes, and verify them. Report the result and unresolved blockers to the delegator.",
  },
  {
    name: "planner",
    description: "Turn a goal and constraints into a concrete, verifiable plan.",
    prompt:
      "Investigate the goal, current implementation and constraints. Propose the smallest coherent sequence of work with verification criteria. Return a plan and its evidence; implement only when explicitly requested.",
    tools: ["read", "grep", "ls", "find", "web_fetch"],
  },
  {
    name: "explorer",
    description: "Inspect code, documents or environments and report grounded findings.",
    prompt:
      "Investigate the supplied brief through read-only inspection. Trace ownership and data flow, and report concrete evidence with source locations. Separate verified facts from uncertainty.",
    tools: ["read", "grep", "ls", "find", "web_fetch"],
  },
  {
    name: "reviewer",
    description: "Assess supplied work for defects and missing verification.",
    prompt:
      "Review the change against its requirements and surrounding behavior. Investigate failure paths and run relevant checks. Report actionable findings with evidence and consequence. Change code only when assigned a fix.",
    tools: ["read", "grep", "ls", "find", "bash", "web_fetch"],
  },
]

export class Presets {
  private readonly document: StoreDocument<NexusPreset.Catalog>

  constructor(member: Client) {
    this.document = new StoreDocument(
      member.profile.storeEntries,
      "opencode.presets",
      "catalog",
      Schema.decodeUnknownSync(NexusPreset.Catalog),
    )
  }

  async catalog() {
    const saved = await this.document.read()

    if (saved) return saved

    return this.document
      .change((current) => {
        if (current) return current

        const presets = seeds.map(
          (seed, index): NexusPreset.Entry => ({
            public_id: createID(),
            name: seed.name,
            description: seed.description,
            configuration: {
              system_prompt: seed.prompt,
              model_mode: index < 2 ? "default" : "follow",
              ...(seed.tools ? { runner_tool_names: seed.tools } : {}),
            },
            role: index < 2 ? null : { name: seed.name, description: seed.description },
          }),
        )

        return {
          presets,
          main_preset_public_id: presets[0].public_id,
          default_bot_preset_public_id: presets[1].public_id,
        }
      })
      .catch(async (error: unknown) => {
        if (!(error instanceof APIError && error.code === "key_taken")) throw error

        const winner = await this.document.read()

        if (!winner) throw error
        return winner
      })
  }

  async command(command: NexusPreset.Command) {
    const catalog = await this.catalog()

    if (command.action === "preset.list") return catalog
    if (command.action === "preset.create" || command.action === "preset.import") {
      const entry = { ...authored(command.value), public_id: createID(), role: null }

      await this.document.change((current) => ({ ...current!, presets: [...current!.presets, entry] }))
      return entry
    }

    const entry = find(catalog, command.id)

    if (command.action === "preset.read") return entry
    if (command.action === "preset.export")
      return { name: entry.name, description: entry.description, configuration: entry.configuration }

    const saved = await this.document.change((current) => {
      const row = find(current!, command.id)

      if (command.action === "preset.remove") {
        if ([current!.main_preset_public_id, current!.default_bot_preset_public_id].includes(row.public_id))
          throw new Error("This Preset is selected as an application default.")

        return { ...current!, presets: current!.presets.filter((item) => item.public_id !== row.public_id) }
      }
      if (command.action === "preset.select-main") return { ...current!, main_preset_public_id: row.public_id }
      if (command.action === "preset.select-default-bot")
        return { ...current!, default_bot_preset_public_id: row.public_id }
      if (command.action === "preset.duplicate") {
        const duplicate = { ...authored({ ...row, name: command.name }), public_id: createID(), role: null }

        return { ...current!, presets: [...current!.presets, duplicate] }
      }
      if (
        command.action === "preset.publish" &&
        current!.presets.some((item) => item.public_id !== row.public_id && item.role?.name === command.role.name)
      )
        throw new Error("Subagent role is already published: " + command.role.name)

      const replacement =
        command.action === "preset.replace"
          ? { ...row, ...authored(command.value) }
          : { ...row, role: command.action === "preset.publish" ? command.role : null }

      return {
        ...current!,
        presets: current!.presets.map((item) => (item.public_id === row.public_id ? replacement : item)),
      }
    })

    if (command.action === "preset.remove") return entry
    if (command.action === "preset.duplicate") return saved.presets.at(-1)!
    return find(saved, command.id)
  }

  async resolve(base: AgentConfigurationInput, id?: string, inheritedModel?: string) {
    const catalog = await this.catalog()
    const preset = find(catalog, id ?? catalog.main_preset_public_id)
    const resolved = compile(preset, base, inheritedModel)
    const roles = catalog.presets.filter((entry) => entry.role)
    const spawn = "nexus.conversation.spawn"
    const roleTools = resolved.configuration.kernel_tools?.includes(spawn)
      ? [
          {
            type: "function" as const,
            function: { name: "spawn" },
            canonical: spawn,
            params: {
              role: {
                maps_to: "declaration",
                description: "Select a published role: " + roles.map((entry) => entry.role!.name).join(", "),
              },
            },
            omit: ["agent"],
          },
        ]
      : []

    return {
      ...resolved,
      configuration: {
        ...resolved.configuration,
        kernel_tools: resolved.configuration.kernel_tools?.filter((name) => name !== spawn),
        tool_definitions: [...(resolved.configuration.tool_definitions ?? []), ...roleTools],
        delegation_catalog: roles.map((entry) => {
          const child = compile(entry, base, inheritedModel)
          const template =
            child.configuration.prompt_template == null
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
              : Schema.decodeUnknownSync(
                  Schema.Struct({ blocks: Schema.Array(Schema.Record(Schema.String, Schema.MutableJson)) }),
                )(child.configuration.prompt_template)
          const memory = entry.configuration.memory_context_limit?.bindings ?? [
            { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
          ]
          const declaration = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
          )(
            JSON.stringify({
              ...child.configuration,
              system_prompt: { content: child.instructions },
              conversation_reach: "subtree",
              memory_context_limit: { bindings: memory.filter((binding) => binding.name === "conversation") },
              prompt_mechanism: "assembly",
              prompt_template: {
                blocks: template.blocks.filter((block) => !(block.type === "slot" && block.slot === "persona")),
              },
            }),
          )

          return {
            name: entry.role!.name,
            description: entry.role!.description,
            model_mode: entry.configuration.model_mode === "follow" ? "caller" : "default",
            inherited_tool_names: [],
            declaration,
          }
        }),
      },
    }
  }
}

function find(catalog: NexusPreset.Catalog, id: string) {
  const row = catalog.presets.find((entry) => entry.public_id === id)

  if (!row) throw new Error("Unknown Preset: " + id)
  return row
}

function authored(input: NexusPreset.Authored) {
  const value = Schema.decodeUnknownSync(NexusPreset.Authored, { onExcessProperty: "error" })({
    name: input.name.trim(),
    description: input.description.trim(),
    configuration: input.configuration,
  })
  const bindings = value.configuration.memory_context_limit?.bindings

  if (
    bindings &&
    (bindings.length > 16 ||
      new Set(bindings.map((binding) => binding.name)).size !== bindings.length ||
      bindings.some((binding) => binding.name !== binding.source.scope) ||
      (bindings.length && !bindings.some((binding) => binding.name === "conversation")))
  )
    throw new Error("Memory limits require unique natural roots including conversation.")
  if (Buffer.byteLength([guidance, value.configuration.system_prompt].filter(Boolean).join("\n\n")) > 65536)
    throw new Error("Preset prompt and shared guidance exceed 64 KiB.")

  return structuredClone(value)
}

export function createID() {
  const bytes = randomBytes(16)

  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6] & 15) | 112
  bytes[8] = (bytes[8] & 63) | 128

  const hex = bytes.toString("hex")

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function compile(preset: NexusPreset.Entry, base: AgentConfigurationInput, inheritedModel?: string) {
  const configuration = preset.configuration
  const value: AgentConfigurationInput = {
    ...base,
    default_model:
      configuration.model_mode === "follow"
        ? (inheritedModel ?? configuration.model ?? base.default_model)
        : (configuration.model ?? base.default_model),
    fallback_models: configuration.fallback_models ? [...configuration.fallback_models] : base.fallback_models,
    runner_tool_names: configuration.runner_tool_names
      ? configuration.runner_tool_names.filter(
          (name) => base.runner_tool_names == null || base.runner_tool_names.includes(name),
        )
      : base.runner_tool_names,
  }

  for (const key of [
    "prompt_template",
    "approval_mode",
    "compaction_policy",
    "lifecycle_hooks",
    "memory_context_limit",
    "conversation_reach",
  ] as const) {
    if (configuration[key] != null) Object.assign(value, { [key]: configuration[key] })
  }

  if (
    base.compaction_policy &&
    typeof base.compaction_policy === "object" &&
    !Array.isArray(base.compaction_policy) &&
    base.compaction_policy.mode === "off"
  )
    value.compaction_policy = base.compaction_policy

  value.approval_rules = [
    ...(base.approval_rules ?? []),
    ...Schema.decodeUnknownSync(Schema.Array(Schema.MutableJson))(configuration.approval_rules ?? []),
  ] as AgentConfigurationInput["approval_rules"]

  if (configuration.tools) {
    value.kernel_tools = base.kernel_tools?.filter((name) => configuration.tools!.includes(name))
    value.tool_definitions = base.tool_definitions?.filter((tool) => {
      const entry = Schema.decodeUnknownSync(
        Schema.Struct({
          function: Schema.optional(Schema.Struct({ name: Schema.String })),
          canonical: Schema.optional(Schema.String),
        }),
      )(tool)

      return (
        configuration.tools!.includes(entry.function?.name ?? "") ||
        configuration.tools!.includes(entry.canonical ?? "")
      )
    })
  }

  if (configuration.mcp)
    value.mcp_tools = base.mcp_tools?.filter(
      (tool) =>
        !configuration.mcp!.disabled_connections.some(
          (reference) => reference.source === "nexus" && reference.connection_public_id === tool.connection_public_id,
        ) &&
        !configuration.mcp!.disabled_tools.some(
          (reference) =>
            reference.source === "nexus" &&
            reference.connection_public_id === tool.connection_public_id &&
            reference.tool_name === tool.tool_name,
        ),
    )

  return {
    preset: preset.public_id,
    configuration: value,
    instructions: [guidance, configuration.system_prompt].filter(Boolean).join("\n\n"),
  }
}
