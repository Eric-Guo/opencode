import { APIError, toolAlias, type Client, type AgentConfigurationInput, type ToolAlias } from "@cybros/agent"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Glob } from "@opencode/util/glob"
import { Schema } from "effect"
import { NexusPreset } from "@opencode/schema/nexus-preset"
import { StoreDocument } from "./document"
import { readPreset, writePreset } from "./preset-document"
import { executionPolicy } from "./execution-policy"
import { memoryPolicy } from "./memory-policy"
import { applyMcp, selectedMcp, withoutMcp, type McpDirectory, type PresetInventory } from "./preset-mcp"
import { summaryPrompt } from "./capabilities"

export const guidance =
  "Some tool schemas are available through tool discovery. Find the capability you need, then invoke the exact returned callable with the tool invocation tool or from code when available. Choose an environment when creating work that touches files, processes or a browser; pure personal, memory, research or coordination work needs no bound directory, and an omitted choice inherits the parent's environment when present. Each accepted task keeps its environment and tool authority, and code or delegated work inherits that frozen surface. Different tasks in one run can use different explicitly selected environments. Inspect available Runners before creating work elsewhere. A person's default Runner change affects future work only. Discovery does not grant new tools or change an accepted target. When a workflow proves reusable or the person asks to teach a skill, draft it with `propose_skill` so they can review and publish it. Coordinate external thread subscriptions, outbox replies and out-of-scope follow-up handbacks with `channel_dispatch`." +
  "\n\n" +
  "You can call several tools in one message. When the calls do not depend on each other — reading multiple documents, searching memory, fetching pages or running checks — put them all in ONE message; they run at the same time and you get every result together. When an execution environment is available, a file or two or three greps is your own work: call `read`/`grep` yourself, several in one message, rather than handing them to another agent. `start_process` is for a server or watcher the person operates, never for a command whose result you need — run that with `bash`. Results that arrive as `<task_result>` or `<answer>` blocks are the kernel delivering previously accepted work; they are not the person, so do not thank or answer them — act on them. Give parallel tasks that edit files disjoint files." +
  "\n\n" +
  executionPolicy +
  "\n\n" +
  "For engineering or artifact work, first finish the smallest usable result, including requested supporting files and run instructions. Preserve a working entry point while improving it: create and check new dependencies before changing the entry point to reference them. Avoid replacing a working implementation merely to reorganize it. When a time budget is supplied, pass the same deadline and deliverables to delegated work and reserve time for verification and the final report. Run the checks relevant to the changes with the tools actually available; inspect rendered pages when browser tools are available. Report what you verified and what remains unverified. A successful file write alone does not prove that the result works." +
  "\n\n" +
  memoryPolicy

const seeds = [
  {
    name: "Personal",
    description: "Act as the owner's personal superagent across conversations, channels, memory, routines and environments.",
    prompt:
      "Act as the owner's personal superagent: take as little of their attention as possible, and deliver as much value as possible. Answer quick questions, memory lookups and routine changes directly and concisely. For sustained multi-step research, writing, automation or engineering work, coordinate focused subagents or background task conversations with an explicit brief, stay silent during intermediate steps, and speak again only for a ready result, one concrete blocking decision, or a clear inability to finish. Ground recalls in your memory directory and session history.",
  },
  {
    name: "Peer",
    description: "Represent a scoped peer or channel bot for a specific audience, group or repository.",
    prompt:
      "Help people in this channel or workspace within your assigned scope and audience boundaries. Reply concisely in the source language, complete authorized work through the available tools, delegate sustained tasks with a clear brief, and hand back out-of-scope follow-ups rather than guessing authority.",
  },
  {
    name: "worker",
    description: "Carry out a bounded research, writing, operational or implementation task.",
    prompt:
      "Complete the supplied task or plan using the explicit brief and available evidence. Inspect what is needed, execute the requested work and verify the outcome. Keep work strictly within the assigned scope. Report the deliverable, verification evidence and any unresolved blocker to the delegator.",
    role: "Choose for ordinary execution of a bounded research, writing, operational or implementation task.",
  },
  {
    name: "planner",
    description: "Turn a goal and constraints into a concrete, verifiable plan.",
    prompt:
      "Investigate the supplied goal, current context and constraints. Identify decisions that affect correctness and propose the smallest coherent sequence of work with verification criteria. Cite the evidence behind assumptions. Return a plan; do not execute changes unless the task explicitly requests them.",
    tools: ["read", "grep", "ls", "find", "web_fetch"],
    role: "Choose when requirements, dependencies or execution order need investigation before acting.",
  },
  {
    name: "explorer",
    description: "Inspect documents, web sources, codebases or environments and report grounded findings.",
    prompt:
      "Investigate the question in the supplied brief using read-only inspection. Trace sources, ownership and facts, locate relevant documents or code, and report concrete evidence with source locations. Separate verified facts from uncertainty. Do not modify the material being inspected.",
    tools: ["read", "grep", "ls", "find", "web_fetch"],
    role: "Choose for focused document, web, codebase or environment investigation and evidence gathering.",
  },
  {
    name: "reviewer",
    description: "Assess supplied work or deliverables for concrete defects and missing verification.",
    prompt:
      "Review the supplied deliverable or change against its requirements and surrounding facts. Investigate specific failure paths and run relevant checks when available. Report actionable findings with evidence, consequence and location; distinguish defects from preferences. Do not alter the reviewed work unless explicitly assigned a fix.",
    tools: ["read", "grep", "ls", "find", "bash", "web_fetch"],
    role: "Choose to review a completed deliverable or change for defects, regressions and gaps in verification.",
  },
]

export class Presets {
  private readonly document: StoreDocument<NexusPreset.Catalog>

  constructor(
    member: Client,
    private readonly inventory?: () => Promise<McpDirectory | PresetInventory>,
    private readonly summarizer = summaryPrompt,
    private readonly botUsing?: (id: string) => Promise<string | undefined>,
  ) {
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
            role: seed.role ? { name: seed.name, description: seed.role } : null,
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

  async command(command: NexusPreset.Command, projectRoot?: string) {
    if (command.action === "preset.tools") {
      const inventory = await this.readInventory()
      return {
        tools: inventory.tools,
        mcp_connections:
          inventory.directory?.map((row) => ({
            ref: row.ref,
            ...(row.previous_ref && { previous_ref: row.previous_ref }),
            name: row.name,
            account_label: row.account_label,
            available: row.available,
            tools: row.tools.map((tool) => ({ name: tool.name, description: tool.description })),
          })) ?? [],
      } satisfies NexusPreset.ToolChoices
    }
    const catalog = await this.catalog()

    if (command.action === "preset.list") return catalog
    if (command.action === "preset.import-project") {
      const imported = new Map<string, NexusPreset.Entry>()
      const skipped: NexusPreset.ProjectImport["skipped"] = []
      const files = projectRoot
        ? await Glob.scan("{.agents,.claude}/agents/*.{md,json}", { cwd: projectRoot, absolute: true })
        : []

      for (const path of files.sort()) {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path))
          const value = readPreset(text, path.endsWith(".json") ? "json" : "md", path)
          if (command.names && !command.names.includes(value.name)) continue
          if (imported.has(value.name)) continue

          imported.set(value.name, { ...authored(value), public_id: createID(), role: null })
        } catch (error) {
          skipped.push({ path, reason: error instanceof Error ? error.message : String(error) })
        }
      }

      const entries = [...imported.values()]
      if (entries.length)
        await this.document.change((current) => ({ ...current!, presets: [...current!.presets, ...entries] }))

      return { imported: entries, skipped, missing: command.names?.filter((name) => !imported.has(name)) ?? [] }
    }
    if (command.action === "preset.defaults") {
      return this.document.change((current) => {
        if (command.main_preset_public_id) find(current!, command.main_preset_public_id)
        if (command.default_bot_preset_public_id) find(current!, command.default_bot_preset_public_id)

        return {
          ...current!,
          main_preset_public_id: command.main_preset_public_id ?? current!.main_preset_public_id,
          default_bot_preset_public_id: command.default_bot_preset_public_id ?? current!.default_bot_preset_public_id,
        }
      })
    }
    if (
      command.action === "preset.create" ||
      command.action === "preset.import" ||
      command.action === "preset.import-document"
    ) {
      const value =
        command.action === "preset.import-document"
          ? readPreset(command.content, command.format, command.filename, command.name)
          : command.value
      const entry = { ...authored(value), public_id: createID(), role: null }

      await this.document.change((current) => ({ ...current!, presets: [...current!.presets, entry] }))
      return entry
    }

    const entry = find(catalog, command.id)

    if (command.action === "preset.read") return entry
    if (command.action === "preset.export-document") return writePreset(entry, command.format)
    if (command.action === "preset.export")
      return { name: entry.name, description: entry.description, configuration: entry.configuration }

    if (command.action === "preset.remove") {
      const bot = await this.botUsing?.(command.id)
      if (bot) throw new Error("Preset is in use by Bot " + bot)
    }
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

  private async readInventory() {
    const inventory = await this.inventory?.()
    if (!inventory || Array.isArray(inventory)) return { directory: inventory, tools: [], kernel: undefined }
    return inventory
  }

  async snapshot() {
    const [catalog, inventory] = await Promise.all([this.catalog(), this.readInventory()])
    return { catalog, ...inventory }
  }

  async resolve(
    base: AgentConfigurationInput,
    id?: string,
    inheritedModel?: string,
    snapshot?: Awaited<ReturnType<Presets["snapshot"]>>,
  ) {
    const current = snapshot ?? (await this.snapshot())
    const catalog = current.catalog
    const preset = find(catalog, id ?? catalog.main_preset_public_id)
    const directory = current.directory
    const resolved = compile(preset, base, inheritedModel, directory, current.kernel)
    const parentMcp = directory
      ? selectedMcp(directory, preset.configuration.mcp).map((entry) => entry.tool.callable_name)
      : (resolved.configuration.mcp_tools ?? []).map((tool) => tool.name)
    const roles = catalog.presets.filter((entry) => entry.role)
    const description =
      "Required. Select one published Subagent role by its exact name.\n" +
      roles.map((entry) => "- " + entry.role!.name + ": " + entry.role!.description).join("\n")

    return {
      ...resolved,
      summarizer: this.summarizer(resolved.configuration.compaction_policy),
      mcp_names: parentMcp,
      configuration: {
        ...withRoles(resolved.configuration, description),
        delegation_catalog: roles.map((entry) => {
          const child = compile(entry, base, inheritedModel, directory, current.kernel)
          const childConfiguration = withRoles(child.configuration, description)
          const summarizer = this.summarizer(childConfiguration.compaction_policy)
          const names = directory
            ? selectedMcp(directory, entry.configuration.mcp).map((entry) => entry.tool.callable_name)
            : (child.configuration.mcp_tools ?? []).map((tool) => tool.name)
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
              ...childConfiguration,
              mcp_tools: [],
              tool_definitions: directory
                ? withoutMcp(childConfiguration.tool_definitions, directory)
                : childConfiguration.tool_definitions,
              system_prompt: { content: child.instructions },
              summarizer: summarizer === null ? null : { content: summarizer },
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
            inherited_tool_names: names.filter((name) => parentMcp.includes(name)),
            declaration,
          }
        }),
      },
    }
  }
}

function withRoles(configuration: AgentConfigurationInput, description: string) {
  const spawn = "nexus.conversation.spawn"
  const tools = [...(configuration.tool_definitions ?? [])]

  if (
    configuration.kernel_tools?.includes(spawn) &&
    !tools.some(
      (tool) => "canonical" in tool && tool.canonical === spawn && (tool as ToolAlias).function.name === "spawn",
    )
  )
    tools.push(toolAlias("spawn", spawn))

  return {
    ...configuration,
    kernel_tools: configuration.kernel_tools?.filter((name) => name !== spawn),
    tool_definitions: tools.map((tool) => {
      if (!("canonical" in tool) || tool.canonical !== spawn) return tool

      const alias = tool as ToolAlias
      const params = Object.entries(alias.params ?? {})
      const name =
        params.find(([, field]) => field.maps_to === "declaration")?.[0] ??
        params.find(([, field]) => field.maps_to === "agent")?.[0] ??
        "role"

      return {
        ...alias,
        params: {
          ...Object.fromEntries(params.filter(([, field]) => !["agent", "declaration"].includes(field.maps_to))),
          [name]: { maps_to: "declaration", description },
        },
        omit: [...new Set([...(alias.omit ?? []).filter((field) => field !== "declaration"), "agent"])],
      }
    }),
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

function compile(
  preset: NexusPreset.Entry,
  base: AgentConfigurationInput,
  inheritedModel?: string,
  directory?: McpDirectory,
  kernel: PresetInventory["kernel"] = [],
) {
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
    const selected = new Set(configuration.tools)
    const canonical = new Set(kernel.filter((tool) => selected.has(tool.name)).map((tool) => tool.canonical_name))
    value.kernel_tools = base.kernel_tools?.filter((name) => selected.has(name) || canonical.has(name))
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
    configuration: directory ? applyMcp(value, directory, configuration.mcp) : value,
    instructions: [guidance, configuration.system_prompt].filter(Boolean).join("\n\n"),
  }
}
