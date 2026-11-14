import {
  APIError,
  TransportError,
  type AgentConfigurationInput,
  type Client,
  type CreateInput,
  type JsonObject,
  type NamedAgent,
} from "@cybros/agent"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { NexusBot } from "@opencode/schema/nexus-bot"
import { StoreDocument } from "./document"
import { Presets } from "./presets"
import { InputAdmissions } from "./admission"

const Locator = Schema.Struct({ public_id: Schema.String, workspace_public_id: Schema.String })
const Receipt = Schema.Struct({
  action: Schema.String,
  request: Schema.Record(Schema.String, Schema.MutableJson),
  selected: Locator,
  completed_at: Schema.Number,
})
const Pending = Schema.Struct({
  key: Schema.String,
  action: Schema.String,
  request: Schema.Record(Schema.String, Schema.MutableJson),
  previous: Schema.NullOr(Locator),
  selected: Schema.optional(Locator),
  workspace: Schema.optional(Schema.String),
  create: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  source: Schema.optional(Locator),
  fork: Schema.optional(
    Schema.Struct({ turn_public_id: Schema.String, variant_public_id: Schema.optional(Schema.String) }),
  ),
})
const State = Schema.Struct({
  current: Schema.NullOr(Locator),
  pending: Schema.optional(Pending),
  receipts: Schema.Record(Schema.String, Receipt),
})
const Creation = Schema.Struct({
  request: Schema.Record(Schema.String, Schema.MutableJson),
  name: Schema.String,
  display_name: Schema.String,
  description: Schema.String,
  settings: NexusBot.Settings,
  configuration: Schema.Record(Schema.String, Schema.MutableJson),
  instructions: Schema.String,
  public_id: Schema.optional(Schema.String),
})

export class Bots {
  private readonly settings = new Map<string, StoreDocument<NexusBot.Settings>>()
  private readonly conversations = new Map<string, StoreDocument<typeof State.Type>>()
  private readonly gates = new Map<string, Promise<void>>()
  private readonly creations = new Map<string, StoreDocument<typeof Creation.Type>>()
  private readonly admissions: InputAdmissions

  constructor(
    private readonly member: Client,
    private readonly presets: Presets,
    private readonly base: () => AgentConfigurationInput,
    private readonly runner: string,
    private readonly environment?: () => Record<string, JsonObject>,
  ) {
    this.admissions = new InputAdmissions(member)
  }

  async command(command: NexusBot.Command) {
    if (command.action === "bot.submit") return this.submit(command)
    const agents = (await this.member.profile.agents.list()).filter(
      (agent) => agent.scope === "instance" && agent.name.startsWith("bot-"),
    )

    if (command.action === "bot.list")
      return Promise.all(
        agents.map(async (agent) => ({
          ...agent,
          settings: await this.readSettings(agent.public_id),
          current: (await this.state(agent.public_id).read())?.current ?? null,
        })),
      )
    if (command.action === "bot.create") return this.create(command, agents)

    const agent = agents.find((row) => row.public_id === command.id)

    if (!agent) throw new Error("Unknown application Bot.")
    if (command.action === "bot.duplicate") {
      const settings = await this.readSettings(agent.public_id)

      return this.create(
        {
          action: "bot.create",
          name: command.name,
          description: agent.description,
          display_name: agent.display_name ?? command.name,
          settings: {
            preset_public_id: settings.preset_public_id,
            audience: command.audience ?? "owner",
            welcome_message: settings.welcome_message,
            subagent: settings.subagent,
          },
        },
        agents,
      )
    }
    if (command.action === "bot.read")
      return {
        ...agent,
        settings: await this.readSettings(agent.public_id),
        current: (await this.state(agent.public_id).read())?.current ?? null,
      }
    if (command.action === "bot.remove") {
      await this.member.profile.agents.remove(agent.name)
      return null
    }
    if (command.action === "bot.history")
      return this.member.conversations.list({
        archived: true,
        metadata_key: "opencode.bot",
        metadata_value: agent.public_id,
      })
    if (command.action === "bot.configure") {
      return this.serial(agent.public_id, async () => {
        const current = await this.readSettings(agent.public_id)
        const next = { ...current, ...command.settings }

        if (current.audience === "external" && next.audience !== "external")
          throw new Error("Duplicate an External Bot to create a Personal Bot.")
        if (next.home_workspace_public_id) await this.member.workspaces.fetch(next.home_workspace_public_id)

        const prepared = await this.prepare(next)

        await this.settingsDocument(agent.public_id).change(() => next)
        const updated = await this.member.profile.agents.declare(agent.name, {
          scope: "instance",
          description: command.description ?? agent.description,
          display_name: command.display_name ?? agent.display_name,
          configuration: prepared.configuration,
          system_prompt: prepared.instructions,
        })
        return { ...updated, settings: next }
      })
    }

    if (!("key" in command)) throw new Error("Unknown Bot command.")

    return this.serial(agent.public_id, () => this.switch(agent, command))
  }

  private async create(command: Extract<NexusBot.Command, { action: "bot.create" }>, agents: NamedAgent[]) {
    const request = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
      JSON.stringify(command),
    )
    const name = "bot-" + command.name
    const document =
      this.creations.get(name) ??
      new StoreDocument(
        this.member.profile.storeEntries,
        "opencode.bot-creation",
        name,
        Schema.decodeUnknownSync(Creation),
      )

    this.creations.set(name, document)

    const prior = await document.read()

    if (prior && !isDeepStrictEqual(prior.request, request))
      throw new Error("This Bot name belongs to another creation request.")
    if (!prior && agents.some((agent) => agent.name === name)) throw new Error("This Bot name is already in use.")

    const candidate = prior ?? (await this.prepareCreation(command, request))
    const intent = await document.change((current) => current ?? candidate)

    if (!isDeepStrictEqual(intent.request, request))
      throw new Error("This Bot name belongs to another creation request.")
    const known = intent.public_id ? agents.find((agent) => agent.public_id === intent.public_id) : undefined

    if (intent.public_id && !known) throw new Error("This Bot identity has been removed.")

    const agent =
      known ??
      (await this.member.profile.agents
        .declare(name, {
          scope: "instance",
          display_name: intent.display_name,
          description: intent.description,
          configuration: intent.configuration,
          system_prompt: intent.instructions,
          create_only: true,
        })
        .catch(async (error: unknown) => {
          if (
            !(
              error instanceof TransportError ||
              (error instanceof APIError && (error.status >= 500 || error.status === 409))
            )
          )
            throw error

          const existing = (await this.member.profile.agents.list()).find(
            (row) => row.name === name && row.scope === "instance",
          )

          if (!existing) throw error
          return existing
        }))

    if (!intent.public_id) await document.change((current) => ({ ...current!, public_id: agent.public_id }))
    const saved = await this.settingsDocument(agent.public_id).change((current) => current ?? intent.settings)

    return { ...agent, settings: saved }
  }

  private async prepareCreation(
    command: Extract<NexusBot.Command, { action: "bot.create" }>,
    request: typeof Creation.Type.request,
  ) {
    const catalog = await this.presets.catalog()
    const settings = {
      audience: "owner" as const,
      home_workspace_public_id: null,
      preset_public_id: catalog.default_bot_preset_public_id,
      welcome_message: null,
      subagent: true,
      ...command.settings,
    }

    if (settings.home_workspace_public_id) await this.member.workspaces.fetch(settings.home_workspace_public_id)

    const prepared = await this.prepare(settings)

    return {
      request,
      name: "bot-" + command.name,
      display_name: command.display_name ?? command.name,
      description: command.description,
      settings,
      configuration: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
        JSON.stringify(prepared.configuration),
      ),
      instructions: prepared.instructions,
    }
  }

  submit(command: Extract<NexusBot.Command, { action: "bot.submit" }>, author = this.member) {
    return this.serial(command.id, () =>
      this.admissions.submit(
        {
          ...command,
          request: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
            JSON.stringify(command),
          ),
        },
        async () => {
          const settings = await this.readSettings(command.id)
          const current = (await this.state(command.id).read())?.current

          if (
            !current ||
            current.public_id !== command.conversation ||
            current.workspace_public_id !== command.workspace
          )
            throw new Error("Select this Bot's current conversation before submitting new input.")

          const chat = author.workspace(command.workspace).conversation(command.conversation)
          const info = await chat.fetch()

          if (info.answering_user_public_id !== command.id || info.archived_at || info.side)
            throw new Error("This Bot conversation cannot receive input.")
          if (settings.audience === "external" && !command.speaker)
            throw new Error("External Bot inputs require their requester identity.")

          const prepared = await this.prepare(settings)
          const model = command.model ?? prepared.configuration.default_model

          if (!model) throw new Error("Select a Bot model before submitting input.")

          return {
            kind: "direct_reply",
            text: command.text,
            answering_user_public_id: command.id,
            ...(command.speaker ? { speaker_public_id: command.speaker } : {}),
            model: { model },
            model_selection: {
              source: command.model ? "explicit" : "default",
              model,
              constraint: command.model ? "route" : "any",
              alternatives: [],
            },
            agent_configuration: Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
            )(JSON.stringify({ ...prepared.configuration, system_prompt: { content: prepared.instructions } })),
            fallback_models: prepared.configuration.fallback_models ?? [],
            ...(settings.audience === "owner" && this.environment ? { executor_contexts: this.environment() } : {}),
          } satisfies CreateInput
        },
        author,
      ),
    )
  }

  private settingsDocument(id: string) {
    const document =
      this.settings.get(id) ??
      new StoreDocument(
        this.member.profile.storeEntries,
        "opencode.bots",
        id,
        Schema.decodeUnknownSync(NexusBot.Settings),
      )

    this.settings.set(id, document)
    return document
  }

  private async readSettings(id: string) {
    const settings = await this.settingsDocument(id).read()

    if (!settings) throw new Error("This Bot has no saved application settings.")
    return settings
  }

  private state(id: string) {
    const document =
      this.conversations.get(id) ??
      new StoreDocument(
        this.member.profile.storeEntries,
        "opencode.bot-conversations",
        id,
        Schema.decodeUnknownSync(State),
      )

    this.conversations.set(id, document)
    return document
  }

  private serial<A>(id: string, run: () => Promise<A>) {
    const pending = (this.gates.get(id) ?? Promise.resolve()).then(run)

    this.gates.set(
      id,
      pending.then(
        () => {},
        () => {},
      ),
    )
    return pending
  }

  private async prepare(settings: NexusBot.Settings) {
    const prepared = await this.presets.resolve(this.base(), settings.preset_public_id)
    const configuration = prepared.configuration

    configuration.runner_tool_names = (configuration.runner_tool_names ?? []).filter((name) => name !== "code")
    configuration.tool_definitions = configuration.tool_definitions?.filter((entry) => {
      const fields = Schema.decodeUnknownSync(
        Schema.Struct({
          function: Schema.optional(Schema.Struct({ name: Schema.String })),
          canonical: Schema.optional(Schema.String),
        }),
      )(entry)

      return (
        fields.function?.name !== "code" &&
        (settings.subagent ||
          !["nexus.conversation.spawn", "nexus.graph.delegate_task", "nexus.conversation.request"].includes(
            fields.canonical ?? "",
          ))
      )
    })
    if (!settings.subagent)
      configuration.kernel_tools = configuration.kernel_tools?.filter(
        (name) =>
          !["nexus.conversation.spawn", "nexus.graph.delegate_task", "nexus.conversation.request"].includes(name),
      )
    if (settings.audience === "external") {
      const catalog = await this.member.tools.list()
      const narrowed = external(configuration)
      const names = catalog
        .filter((tool) => narrowed.kernel_tools?.includes(tool.canonical_name))
        .map((tool) => tool.name)

      narrowed.approval_rules = [
        ...(configuration.approval_rules ?? []).filter((rule) => ["deny", "ask"].includes(rule.verdict)),
        ...(names.length ? [{ tool: names.join("|"), verdict: "allow" as const }] : []),
      ]
      Object.assign(configuration, narrowed)
    }

    return {
      configuration,
      instructions:
        prepared.instructions +
        "\n\nBot main conversations keep Code Mode off." +
        (settings.subagent ? "" : " Complete work directly; Subagent is off."),
    }
  }

  private async switch(
    agent: NamedAgent,
    command: Exclude<Extract<NexusBot.Command, { key: string }>, { action: "bot.submit" }>,
  ) {
    const document = this.state(agent.public_id)
    const request = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
      Object.fromEntries(Object.entries(command).filter(([key]) => key !== "key")),
    )
    const original = await document.read()
    const prior =
      original?.receipts[command.key] ?? (original?.pending?.key === command.key ? original.pending : undefined)

    if (prior && (prior.action !== command.action || !isDeepStrictEqual(prior.request, request)))
      throw new Error("This operation key belongs to another Bot command.")

    await this.recover(agent.public_id)

    const state = (await document.read()) ?? { current: null, receipts: {} }
    const receipt = state.receipts[command.key]

    if (receipt) return { current: state.current, selected: receipt.selected, replayed: true }

    const settings = await this.readSettings(agent.public_id)
    const pending: typeof Pending.Type = { key: command.key, action: command.action, request, previous: state.current }
    const selected =
      command.action === "bot.current" && state.current
        ? await this.member.workspace(state.current.workspace_public_id).conversation(state.current.public_id).fetch()
        : undefined
    const next: typeof Pending.Type =
      selected && !selected.archived_at
        ? { ...pending, selected: state.current! }
        : command.action === "bot.resume" || command.action === "bot.fork"
          ? {
              ...pending,
              ...(command.action === "bot.resume"
                ? { selected: { public_id: command.conversation, workspace_public_id: command.workspace } }
                : {
                    source: { public_id: command.conversation, workspace_public_id: command.workspace },
                    fork: { turn_public_id: command.turn, variant_public_id: command.variant },
                  }),
            }
          : {
              ...pending,
              workspace: settings.home_workspace_public_id ?? undefined,
              create: {
                answering_user_public_id: agent.public_id,
                default_runner_executor_public_id: settings.audience === "external" ? null : this.runner,
                metadata: { "opencode.bot": agent.public_id },
              },
            }

    if (!next.selected && !next.source && !next.workspace)
      throw new Error("Choose a Home Workspace before opening a Bot conversation.")
    const target = next.selected ?? next.source

    if (target) {
      const conversation = await this.member
        .workspace(target.workspace_public_id)
        .conversation(target.public_id)
        .fetch()

      if (
        conversation.answering_user_public_id !== agent.public_id ||
        conversation.metadata["opencode.bot"] !== agent.public_id ||
        conversation.side
      )
        throw new Error("Choose a root conversation from this Bot's history.")
    }

    await document.change(() => ({
      ...state,
      pending: next,
      receipts: Object.fromEntries(
        Object.entries(state.receipts).filter(([, row]) => row.completed_at > Date.now() - 86400000),
      ),
    }))
    await this.recover(agent.public_id)

    const completed = (await document.read())!

    return { current: completed.current, selected: completed.receipts[command.key].selected, replayed: false }
  }

  private async recover(id: string) {
    const document = this.state(id)
    const state = await document.read()
    const pending = state?.pending

    if (!state || !pending) return

    const created = pending.selected
      ? undefined
      : pending.source
        ? await this.member
            .workspace(pending.source.workspace_public_id)
            .conversation(pending.source.public_id)
            .fork(pending.fork!, { idempotencyKey: pending.key })
        : await this.member
            .workspace(pending.workspace!)
            .conversations.create(pending.create!, { idempotencyKey: pending.key })
    const selected = pending.selected ?? {
      public_id: created!.conversation.public_id,
      workspace_public_id: created!.conversation.workspace_public_id,
    }

    if (!pending.selected)
      await document.change((current) => ({ ...current!, pending: { ...current!.pending!, selected } }))

    const chat = this.member.workspace(selected.workspace_public_id).conversation(selected.public_id)
    const info = await chat.fetch()

    if (info.archived_at) await chat.unarchive()
    if (info.metadata["opencode.bot"] !== id)
      await chat.update({ metadata: { ...info.metadata, "opencode.bot": id }, lock_version: info.lock_version })
    if (pending.previous && !isDeepStrictEqual(pending.previous, selected)) {
      const workspace = await this.member.workspaces.fetch(pending.previous.workspace_public_id)

      if (workspace.state !== "archived")
        await this.member
          .workspace(pending.previous.workspace_public_id)
          .conversation(pending.previous.public_id)
          .archive()
    }

    await document.change((current) => ({
      current: selected,
      receipts: {
        ...current!.receipts,
        [pending.key]: { action: pending.action, request: pending.request, selected, completed_at: Date.now() },
      },
    }))
  }
}

function external(base: AgentConfigurationInput): AgentConfigurationInput {
  const allowed = new Set([
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
    "nexus.conversation.search",
    "nexus.conversation.read",
    "nexus.conversation.status",
    "nexus.conversation.cancel",
  ])

  return {
    ...base,
    kernel_tools: base.kernel_tools?.filter((name) => allowed.has(name)),
    tool_definitions: [],
    runner_tool_names: [],
    runner_executor_public_ids: [],
    mcp_tools: [],
    delegation_catalog: [],
    approval_mode: "rules",
    conversation_reach: "subtree",
    memory_context_limit: {
      bindings: [
        { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
        { name: "speaker", source: { scope: "speaker" }, access: "read_write" },
        { name: "workspace", source: { scope: "workspace" }, access: "read" },
      ],
    },
    prompt_mechanism: "assembly",
    prompt_template: {
      blocks: [
        { type: "slot", slot: "system_prompt" },
        { type: "slot", slot: "character" },
        { type: "memory" },
        { type: "history" },
        { type: "skills" },
        { type: "input" },
      ],
    },
  }
}
