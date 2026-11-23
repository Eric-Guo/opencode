import { TURN_POSITION_CEILING } from "./history"
import { executionSnapshot } from "./execution"
import type {
  AgentConfigurationInput,
  Client,
  Conversation,
  CreateInput,
  ExecutionSnapshot,
  EstimateInput,
  JsonObject,
  RequestOptions,
  ToolDefinition,
} from "@cybros/agent"
import { Schema } from "effect"
import type { Nexus } from "@opencode/schema/nexus"
import type { RealtimeClient } from "@cybros/agent/realtime"
import type { ApprovalGrant } from "./approval-grant"
import { setTimeout } from "node:timers/promises"
import { Presets } from "./presets"
import { Bots } from "./bots"
import { InputAdmissions } from "./admission"
import { Operations } from "./operations"
import { addressedAgent, foreignInput } from "./foreign-admission"
import type { McpDirectory, PresetInventory } from "./preset-mcp"
import { MemoryReviews } from "./memory-review"
import { InferenceFollowers } from "./inference"
import { Until, untilParagraph } from "./until"
import { TurnLifecycle } from "./turn-lifecycle"
import { boundRootDescription, Environments } from "./environments"
import { SideConversations, sideLeads, sideReadTools } from "./sides"
import { StoreDocument } from "./document"
import { ConversationTitles } from "./conversation-titles"
import { Runners } from "./runners"
import { Workspaces } from "./workspaces"
import type { ExtensionLifecycle } from "./extension-lifecycle"
import { isSubagentTool } from "./bot-policy"
import { summaryPrompt } from "./capabilities"

type Preparation = {
  instructions?: string
  agent_configuration: JsonObject
  model?: string
  fallback_models: string[]
  tools?: readonly string[]
  executor_contexts?: Record<string, JsonObject>
}

export type ApplicationInput = {
  workspace: string
  conversation: string
  key: string
  principal?: string
  target?: string
  text: string
  instructions?: string
  approval?: "bypass" | "ask" | "rules"
  deliver_at?: string
  answering_user_public_id?: string
  addressed?: boolean
  deliver_in?: string
  reasoning_effort?: string
  reasoning_enabled?: boolean
  side?: boolean
  attachments?: readonly string[]
  until?: { command: string; attempts?: number; directory?: string }
  model?: string | null
  preset?: string
  delivery?: CreateInput["delivery_mode"]
  executor_contexts?: Record<string, JsonObject>
  tools?: readonly string[]
  prepared?: Awaited<ReturnType<NexusApplication["prepare"]>>
  preparation?: () => Promise<Preparation>
}

/** Surface-independent admission and following. Nexus remains the durable execution owner. */
export class NexusApplication {
  readonly inference: InferenceFollowers
  readonly titles: ConversationTitles
  readonly operations: Operations
  readonly presets: Presets
  readonly bots: Bots
  readonly memoryReviews: MemoryReviews
  readonly until: Until
  readonly lifecycle: TurnLifecycle
  readonly environments: Environments
  readonly sides: SideConversations
  readonly runners: Runners
  readonly workspaces: Workspaces
  private readonly admissions: InputAdmissions

  constructor(
    private readonly member: Client,
    readonly identity: { agent: string; runner: string; workspace: string },
    private readonly base: () => AgentConfigurationInput,
    private readonly environment?: () => Record<string, JsonObject>,
    private readonly policy?: (workspace: string, conversation: string, preset?: string) => Promise<Preparation>,
    private readonly event?: (name: string, value: Schema.Json) => Promise<void>,
    mcp?: () => Promise<McpDirectory | PresetInventory>,
    private readonly hooks?: ExtensionLifecycle,
    private readonly approvals?: {
      grant(value: ApprovalGrant): Promise<"saved" | "already">
      list(): readonly ApprovalGrant[]
    },
    private readonly realtimeFactory?: () => RealtimeClient,
    readonly defaults: () => {
      code_mode: boolean
      subagent: boolean
      title_model: string | null
      bash_timeout_seconds?: number
      hints?: (model: string) => string
      adaptations?: (model?: string) => JsonObject
      summarizer?: (policy: AgentConfigurationInput["compaction_policy"]) => string | null
    } = () => ({ code_mode: true, subagent: true, title_model: null }),
    admissionDirectory?: string,
  ) {
    this.inference = new InferenceFollowers(member, realtimeFactory)
    this.titles = new ConversationTitles(member, () => this.defaults().title_model)
    this.environments = new Environments(member, identity)
    this.runners = new Runners(member, identity.runner)
    this.workspaces = new Workspaces(member)
    this.operations = new Operations(member, this, identity)
    this.admissions = new InputAdmissions(
      member,
      hooks,
      async (input, notes) => {
        if (notes["nexus.until"]) await this.until.save(input.workspace, input.conversation, notes["nexus.until"])
        if (notes["nexus.side"]) {
          const side = Schema.decodeUnknownSync(
            Schema.Struct({ at: Schema.Number, model: Schema.optional(Schema.String) }),
          )(notes["nexus.side"])
          await this.sides.touch(input.workspace, input.conversation, side.at, side.model)
        }
        this.lifecycle.adopt(input.workspace, input.conversation)
      },
      (target, input, body, replayed) => this.titles.accept(target, input, body, replayed),
      admissionDirectory,
    )
    this.presets = new Presets(
      member,
      mcp,
      (policy) => (this.defaults().summarizer ?? summaryPrompt)(policy),
      (id) => this.bots.usingPreset(id),
    )
    this.bots = new Bots(
      member,
      this.presets,
      base,
      identity.runner,
      environment,
      event,
      this.admissions,
      (model) => this.defaults().hints?.(model) ?? "",
    )
    this.memoryReviews = new MemoryReviews(member, identity.agent, event)
    this.until = new Until(member, identity.agent, () => this.defaults().bash_timeout_seconds ?? 120)
    this.lifecycle = new TurnLifecycle(member, identity.agent, this.admissions, hooks, (name, value) =>
      this.notify(name, value),
    )
    this.sides = new SideConversations(member, identity.agent, {
      hosts: () => this.lifecycle.hostsSnapshot(),
      prepare: async (workspace, conversation, foreign) => {
        const model =
          (await this.settledModel(workspace, conversation)) ??
          (await this.admissions.latestModel(workspace, conversation))
        if (model) return { model }
        if (foreign) return {}
        return this.policy ? this.policy(workspace, conversation) : this.prepare()
      },
      copyEnvironment: (workspace, parent, conversation, runner) =>
        this.environments.copy(workspace, parent, conversation, runner),
      adopt: (workspace, conversation) => this.lifecycle.adopt(workspace, conversation),
      ended: (workspace, conversation) => this.lifecycle.ended(workspace, conversation),
    })
  }

  async setModes(workspace: string, conversation: string, patch: { code_mode?: boolean; subagent?: boolean }) {
    const document = new StoreDocument(
      this.member.workspace(workspace).conversation(conversation).storeEntries,
      "opencode",
      "modes",
      Schema.decodeUnknownSync(Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean })),
    )
    return document.change((current) => ({ code_mode: true, subagent: true, ...current, ...patch }))
  }

  openSide(
    input: { key: string; parent?: string; workspace?: string; tools?: "read" | "write" },
    options: RequestOptions = {},
  ) {
    return this.sides.open({ ...input, workspace: input.workspace ?? this.identity.workspace }, options)
  }

  async watch(signal: AbortSignal) {
    const stopped = new AbortController()
    const combined = AbortSignal.any([signal, stopped.signal])
    const observers = [this.lifecycle.watch(combined), this.sides.watch(combined)]
    try {
      await Promise.race(observers)
    } finally {
      stopped.abort()
      await Promise.allSettled(observers)
      await Promise.all([this.titles.close(), this.inference.close()])
    }
  }

  get realtimeAvailable() {
    return !!this.realtimeFactory
  }

  realtime() {
    if (!this.realtimeFactory) throw new Error("Realtime subscriptions are unavailable.")
    return this.realtimeFactory()
  }

  async grantRule(value: ApprovalGrant) {
    if (!this.approvals) throw new Error("Session approval grants are unavailable.")

    return this.approvals.grant(value)
  }

  rules() {
    return this.approvals?.list() ?? []
  }

  get client() {
    return this.member
  }

  async notify(name: string, value: Schema.Json) {
    if (name === "host.ended") {
      const ended = Schema.decodeUnknownSync(Schema.Struct({ workspace: Schema.String, conversation: Schema.String }))(
        value,
      )
      await this.environments.release(ended.workspace, ended.conversation)
    }
    await this.event?.(name, value)
  }

  bindings(workspace: string, conversation: string) {
    return this.hooks?.bindings({ workspace, conversation }) ?? Promise.resolve([])
  }

  async prepare(
    preset?: string,
    target?: { workspace: string; conversation: string },
    snapshot?: Awaited<ReturnType<Presets["snapshot"]>>,
  ) {
    const base = this.base()
    const current = snapshot ?? (await this.presets.snapshot())
    const catalog = current.catalog
    const selected = catalog.presets.find((entry) => entry.public_id === (preset ?? catalog.main_preset_public_id))
    const inherited =
      target &&
      (selected?.configuration.model_mode === "follow" || (!selected?.configuration.model && !base.default_model))
        ? await this.settledModel(target.workspace, target.conversation)
        : undefined
    const resolved = await this.presets.resolve(base, preset, inherited, current)

    return {
      agent_configuration: Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
      )(
        JSON.stringify({
          ...resolved.configuration,
          system_prompt: { content: resolved.instructions },
          summarizer: resolved.summarizer === null ? null : { content: resolved.summarizer },
        }),
      ),
      model: resolved.configuration.default_model ?? inherited,
      fallback_models: resolved.configuration.fallback_models ?? [],
    }
  }

  async selectModel(
    workspace: string,
    conversation: Conversation,
    supplied: string | null | undefined,
    fallback: string | undefined,
  ) {
    const initial = conversation.metadata["opencode.initial_model"]
    const prior =
      supplied === undefined && !conversation.side
        ? await this.admissions.modelSelection(
            workspace,
            conversation.public_id,
            conversation.answering_user_public_id === this.identity.agent && typeof initial === "string"
              ? { model: initial }
              : undefined,
          )
        : undefined
    if (prior) return prior

    const model = supplied ?? fallback
    if (model)
      return {
        source: supplied ? ("explicit" as const) : ("default" as const),
        constraint: supplied ? ("route" as const) : ("any" as const),
        model,
        alternatives: [],
      }
  }

  private async settledModel(workspace: string, conversation: string): Promise<string | undefined> {
    const scope = this.member.workspace(workspace)
    let before: number | undefined
    do {
      const page = await scope
        .conversation(conversation)
        .turns.list({ before_position: before ?? TURN_POSITION_CEILING, limit: 100, include_hidden: true })
        .catch(() => undefined)
      if (!page) return
      const turn = page.items
        .toSorted((a, b) => b.position - a.position)
        .find(
          (row) =>
            row.kind === "direct_reply" &&
            !row.inherited &&
            !row.reference &&
            ["completed", "failed", "canceled"].includes(row.status) &&
            row.active_variant?.status === row.status,
        )
      if (turn) {
        if (!turn.active_variant?.run_public_id) return
        const run = await scope
          .run(turn.active_variant.run_public_id)
          .fetch()
          .catch(() => undefined)
        if (run?.turn?.public_id !== turn.public_id || run.turn.conversation_public_id !== conversation) return
        // Only the mainline tail is a preference; a tool task's model switch is local to that task.
        const model = run.turn.model
        if (typeof model?.model === "string") return model.model
        if (typeof model?.provider_id === "string" && typeof model.model_ref === "string")
          return model.provider_id + "/" + model.model_ref
        return
      }
      before = page.before_position ?? undefined
    } while (before !== undefined)
  }

  async publish(file: Blob, name: string, options: RequestOptions = {}) {
    const upload = await this.member.uploads.create(file, name, options)

    return {
      type: "resource_link",
      uri: "nexus://uploads/" + upload.public_id,
      name: upload.filename,
      mimeType: upload.content_type,
      size: upload.byte_size,
    }
  }

  async open(
    input: {
      key: string
      title?: string
      workspace?: string
      runner?: string | null
      environment?: Nexus.EnvironmentRoots
      model?: string
      agent?: string
      restricted?: boolean
    },
    options: RequestOptions = {},
  ) {
    const workspace = input.workspace ?? this.identity.workspace
    if (input.workspace) await this.workspaces.require(workspace, options)
    const recipient = input.agent
      ? await addressedAgent(this.member, workspace, this.identity.agent, input.agent, options, this.hooks?.agents?.())
      : this.identity.agent
    const registered =
      recipient !== this.identity.agent &&
      (await this.member.profile.agents.list(options)).some(
        (agent) => agent.public_id === recipient && this.hooks?.agents?.().includes(agent.name),
      )
    const own = input.restricted
      ? (await this.member.workspace(workspace).principals(options)).find(
          (row) => row.public_id === this.identity.agent,
        )
      : undefined
    const runner =
      input.runner === undefined
        ? recipient === this.identity.agent || registered
          ? await this.runners.default()
          : null
        : input.runner
    const paths = input.environment
      ? await this.environments.validate(
          input.environment.root,
          input.environment.directories ?? [],
          runner ?? this.identity.runner,
        )
      : undefined
    const model = input.model?.trim()
    const metadata =
      recipient === this.identity.agent
        ? {
            "opencode.title_pending": !input.title,
            "opencode.initial_modes": { code_mode: this.defaults().code_mode, subagent: this.defaults().subagent },
          }
        : undefined
    const result = await this.member.workspace(workspace).conversations.create(
      {
        answering_user_public_id: recipient,
        default_runner_executor_public_id: runner,
        ...(input.restricted
          ? {
              access: {
                default: "none" as const,
                entries: own?.steward_public_id
                  ? [{ user_public_id: own.steward_public_id, level: "full" as const }]
                  : [],
              },
            }
          : {}),
        title: input.title,
        metadata: model ? { ...metadata, "opencode.initial_model": model } : metadata,
      },
      { ...options, idempotencyKey: input.key },
    )
    const environment = paths
      ? await this.environments.initialize(
          workspace,
          result.conversation.public_id,
          result.conversation.default_runner?.executor_public_id ?? this.identity.runner,
          paths,
        )
      : undefined
    if (recipient === this.identity.agent) {
      const modes = new StoreDocument(
        this.member.workspace(workspace).conversation(result.conversation.public_id).storeEntries,
        "opencode",
        "modes",
        Schema.decodeUnknownSync(Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean })),
      )
      await modes.change(
        (current) =>
          current ??
          Schema.decodeUnknownSync(Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean }))(
            result.conversation.metadata["opencode.initial_modes"] ?? {
              code_mode: this.defaults().code_mode,
              subagent: this.defaults().subagent,
            },
          ),
      )
    }
    this.lifecycle.adopt(result.conversation.workspace_public_id, result.conversation.public_id)
    return environment ? { ...result, environment } : result
  }

  async submit(input: ApplicationInput, author = this.member, options: RequestOptions = {}) {
    return this.admissions.submit(
      this.admissionRequest(input),
      () => this.admit(input, author, options),
      author,
      options,
    )
  }

  async preview(
    input: {
      workspace: string
      conversation: string
      prompt?: string
      model?: string
      answering_user_public_id?: string
      variables?: JsonObject
      template?: JsonObject
    },
    info: Conversation,
    options: RequestOptions,
  ) {
    const chat = this.member.workspace(input.workspace).conversation(input.conversation)
    const prepared: EstimateInput = await this.admit(
      { ...input, text: input.prompt ?? "", addressed: true },
      this.member,
      options,
      info,
    )

    return chat.estimateInput(
      {
        prompt: input.prompt,
        render: true,
        model: prepared.model,
        agent_configuration: prepared.agent_configuration,
        model_selection: prepared.model_selection,
        fallback_models: prepared.fallback_models,
        inline: prepared.inline,
        answering_user_public_id: prepared.answering_user_public_id,
        variables: input.variables,
        template: input.template,
      },
      options,
    )
  }

  captureInput(input: ApplicationInput, author = this.member, options: RequestOptions = {}) {
    return this.admissions.capture(this.admissionRequest(input), () => this.admit(input, author, options))
  }

  private admissionRequest(input: ApplicationInput) {
    return {
      ...input,
      request: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
        JSON.stringify({ ...input, prepared: undefined, preparation: undefined }),
      ),
    }
  }

  private async admit(
    input: Omit<ApplicationInput, "key">,
    author: Client,
    options: RequestOptions,
    info?: Conversation,
  ) {
    const conversation =
      info ?? (await author.workspace(input.workspace).conversation(input.conversation).fetch(options))

    const side = conversation.side ? await this.sides.read(input.workspace, input.conversation) : null
    const recipient = input.addressed
      ? await addressedAgent(
          author,
          input.workspace,
          this.identity.agent,
          input.answering_user_public_id ?? conversation.answering_user_public_id,
          options,
          this.hooks?.agents?.(),
        )
      : undefined
    const initialModel = conversation.metadata["opencode.initial_model"]
    const initial =
      conversation.answering_user_public_id === (recipient ?? this.identity.agent) && typeof initialModel === "string"
        ? { model: initialModel, addressedTo: recipient !== this.identity.agent ? recipient : undefined }
        : undefined

    if (recipient && recipient !== this.identity.agent && !side) {
      if (conversation.archived_at || conversation.side)
        throw new Error("This conversation cannot receive addressed input.")
      if (input.until) throw new Error("Acceptance checks require this runtime's own agent.")
      const registered = (await this.member.profile.agents.list(options)).find(
        (agent) => agent.public_id === recipient && this.hooks?.agents?.().includes(agent.name),
      )
      const previous =
        initial && input.model === undefined
          ? await this.admissions.modelSelection(input.workspace, input.conversation, initial)
          : undefined
      const selected = input.model ?? previous?.model
      const model =
        selected ?? (registered && !registered.configuration.default_model ? this.base().default_model : undefined)
      return foreignInput(
        {
          ...input,
          model: model ?? undefined,
          ...(registered && model
            ? {
                model_selection: {
                  source: selected ? "explicit" : "default",
                  constraint: selected ? "route" : "any",
                  model,
                  alternatives: [],
                },
              }
            : {}),
          ...(registered && conversation.default_runner
            ? {
                executor_contexts: {
                  [conversation.default_runner.executor_public_id]: await this.environments.capture(
                    input.workspace,
                    input.conversation,
                    conversation.default_runner.executor_public_id,
                  ),
                },
              }
            : {}),
        },
        recipient,
      )
    }
    if (side && input.until) throw new Error("Acceptance-check work must start in a new main conversation.")
    if (
      (!recipient &&
        !side &&
        conversation.answering_user_public_id !== (input.answering_user_public_id ?? this.identity.agent)) ||
      conversation.archived_at ||
      (conversation.side && !side)
    )
      throw new Error("This conversation cannot receive Main Agent input.")

    const foreignSide = !!side && conversation.answering_user_public_id !== this.identity.agent
    const inherited = !!side && (conversation.agent_configuration_present || foreignSide)
    const prepared: Preparation = inherited
      ? {
          agent_configuration: {},
          model: side?.model,
          fallback_models: [],
          ...(!foreignSide && conversation.default_runner
            ? {
                executor_contexts: {
                  [conversation.default_runner.executor_public_id]: await this.environments.capture(
                    input.workspace,
                    input.conversation,
                    conversation.default_runner.executor_public_id,
                  ),
                },
              }
            : {}),
        }
      : (input.prepared ??
        (input.preparation
          ? await input.preparation()
          : this.policy
            ? await this.policy(input.workspace, input.conversation, input.preset)
            : await this.prepare(input.preset, { workspace: input.workspace, conversation: input.conversation })))
    const selection = await this.selectModel(input.workspace, conversation, input.model, side?.model ?? prepared.model)
    const model = selection?.model

    if (!model && !inherited) throw new Error("Select a model before submitting input.")

    const tools = side
      ? await (async () => {
          if (foreignSide && side.tools === "write") return input.tools
          const assembly = await this.member.tools.assemble(
            {
              ...(inherited
                ? { conversation_public_id: input.conversation }
                : { configuration: prepared.agent_configuration }),
              default_runner_executor_public_id: conversation.default_runner?.executor_public_id ?? null,
            },
            options,
          )
          const modes = await this.sides.modes(input.workspace, input.conversation)
          const definitions = Schema.decodeUnknownSync(
            Schema.Array(
              Schema.Struct({
                function: Schema.optional(Schema.Struct({ name: Schema.String })),
                name: Schema.optional(Schema.String),
                canonical: Schema.optional(Schema.String),
                route: Schema.optional(
                  Schema.Struct({ kind: Schema.String, tool_name: Schema.optional(Schema.String) }),
                ),
              }),
            ),
          )(assembly.tool_definitions)
          const available = definitions.filter((tool) => {
            const name = tool.function?.name ?? tool.name ?? ""
            return (
              name &&
              (modes.code_mode || name !== "code") &&
              (modes.subagent || !isSubagentTool(name, tool.canonical, tool.route)) &&
              (!prepared.tools || prepared.tools.includes(name))
            )
          })
          const selected =
            side.tools === "read"
              ? sideReadTools.flatMap((served) =>
                  available
                    .filter(
                      (tool) =>
                        tool.route?.kind !== "mcp" &&
                        (tool.route?.tool_name ?? tool.function?.name ?? tool.name) === served,
                    )
                    .map((tool) => tool.function?.name ?? tool.name!),
                )
              : available.map((tool) => tool.function?.name ?? tool.name!)
          if (input.tools?.some((name) => !selected.includes(name)))
            throw new Error("tool_names cannot expand a side conversation's tool posture.")
          return input.tools ?? selected
        })()
      : input.tools
        ? input.tools.filter((name) => !prepared.tools || prepared.tools.includes(name))
        : prepared.tools
    const executor_contexts =
      input.executor_contexts ?? prepared.executor_contexts ?? (foreignSide ? undefined : this.environment?.())
    const runner = conversation.default_runner?.executor_public_id
    const lead = [
      runner ? boundRootDescription(executor_contexts?.[runner]) : undefined,
      input.instructions,
      model ? this.defaults().hints?.(model) : undefined,
    ]
      .filter(Boolean)
      .join("\n\n")
    const instructions = Schema.decodeUnknownSync(
      Schema.Struct({ system_prompt: Schema.optional(Schema.Struct({ content: Schema.String })) }),
    )(prepared.agent_configuration).system_prompt?.content
    const acceptance = input.until
      ? await (async () => {
          if (!runner || !executor_contexts?.[runner])
            throw new Error("Acceptance checks require a captured runner environment.")
          if (
            (await author.workspace(input.workspace).conversation(input.conversation).turns.list({ limit: 1 }, options))
              .items.length
          )
            throw new Error("Start acceptance-check work in a new conversation.")
          const assembly = await this.member.tools.assemble(
            {
              default_runner_executor_public_id: runner,
              configuration: prepared.agent_configuration,
            },
            options,
          )
          const policy = {
            command: input.until!.command,
            attempts: input.until!.attempts ?? 5,
            directory: input.until!.directory ?? null,
          }
          return this.until.plan({
            ...policy,
            runner,
            seed: {
              model: { model: model! },
              executor_contexts,
              fallback_models: prepared.fallback_models,
              tools: assembly.tool_definitions.filter((tool) => {
                const definition = Schema.decodeUnknownSync(
                  Schema.Struct({
                    function: Schema.optional(Schema.Struct({ name: Schema.String })),
                    name: Schema.optional(Schema.String),
                  }),
                )(tool)
                return !tools || tools.includes(definition.function?.name ?? definition.name ?? "")
              }) as ToolDefinition[],
              instructions: [instructions, lead, untilParagraph(policy)].filter(Boolean).join("\n\n"),
            },
          })
        })()
      : undefined
    return {
      kind: "direct_reply",
      text: input.text,
      ...((recipient ?? input.answering_user_public_id)
        ? { answering_user_public_id: recipient ?? input.answering_user_public_id }
        : {}),
      ...(side
        ? {
            inline: [
              { role: "user" as const, position: "tail" as const, text: sideLeads[side.tools] },
              ...(input.instructions
                ? [{ role: "user" as const, position: "tail" as const, text: input.instructions }]
                : []),
            ],
            admission_notes: {
              "nexus.side": { at: Date.now(), ...(input.model ? { model: input.model } : {}) },
              ...(foreignSide ? { "nexus.addressed": { recipient: conversation.answering_user_public_id } } : {}),
            },
          }
        : { instructions: lead }),
      ...(input.approval ? { approval_mode: input.approval } : {}),
      ...(input.deliver_at ? { deliver_at: input.deliver_at } : {}),
      ...(input.deliver_in ? { deliver_in: input.deliver_in } : {}),
      ...(input.reasoning_effort !== undefined || input.reasoning_enabled !== undefined
        ? {
            configuration: {
              ...(input.reasoning_effort !== undefined ? { reasoning_effort: input.reasoning_effort } : {}),
              ...(input.reasoning_enabled !== undefined ? { reasoning_enabled: input.reasoning_enabled } : {}),
            },
          }
        : {}),
      ...(input.attachments ? { attachments: [...input.attachments] } : {}),
      ...(!inherited
        ? {
            agent_configuration: prepared.agent_configuration,
            model: { model: model! },
            model_selection: selection!,
            fallback_models: prepared.fallback_models,
          }
        : input.model
          ? { model: { model: input.model } }
          : {}),
      delivery_mode: input.delivery,
      expected_steering_run_public_id: input.target,
      executor_contexts,
      ...(acceptance
        ? {
            ...acceptance,
            instructions: [lead, acceptance.instructions].filter(Boolean).join("\n\n"),
          }
        : {}),
      ...(tools ? { tool_names: [...tools] } : {}),
    } satisfies CreateInput & { admission_notes?: JsonObject }
  }

  async *follow(
    workspace: string,
    conversation: string,
    input: string,
    options: RequestOptions = {},
  ): AsyncGenerator<ExecutionSnapshot> {
    const execution = this.member.workspace(workspace).conversation(conversation).inputExecution(input)
    let previous = ""

    while (!options.signal?.aborted) {
      const snapshot = await execution.recover(options).then(executionSnapshot)

      if (execution.blocked_reason) throw new Error("Input blocked: " + execution.blocked_reason)
      if (snapshot && JSON.stringify(snapshot) !== previous) {
        previous = JSON.stringify(snapshot)
        yield snapshot
      }

      if (snapshot?.terminal || snapshot?.needs_attention) return

      await setTimeout(250, undefined, { signal: options.signal })
    }

    options.signal?.throwIfAborted()
  }
}
