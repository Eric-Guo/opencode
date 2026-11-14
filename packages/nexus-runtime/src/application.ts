import type {
  AgentConfigurationInput,
  Client,
  CreateInput,
  ExecutionSnapshot,
  JsonObject,
  RequestOptions,
  ToolDefinition,
} from "@cybros/agent"
import { Schema } from "effect"
import type { RealtimeClient } from "@cybros/agent/realtime"
import type { ApprovalGrant } from "./approval-grant"
import { setTimeout } from "node:timers/promises"
import { Presets } from "./presets"
import { Bots } from "./bots"
import { InputAdmissions } from "./admission"
import { Operations } from "./operations"
import { addressedAgent, foreignInput } from "./foreign-admission"
import type { McpDirectory } from "./preset-mcp"
import { MemoryReviews } from "./memory-review"
import { Until, untilParagraph } from "./until"
import { TurnLifecycle } from "./turn-lifecycle"
import { Environments } from "./environments"
import { SideConversations, sideLeads, sideReadTools } from "./sides"
import { Runners } from "./runners"
import type { ExtensionLifecycle } from "./extension-lifecycle"

type Preparation = {
  agent_configuration: JsonObject
  model?: string
  fallback_models: string[]
  tools?: readonly string[]
  executor_contexts?: Record<string, JsonObject>
}

/** Surface-independent admission and following. Nexus remains the durable execution owner. */
export class NexusApplication {
  readonly operations: Operations
  readonly presets: Presets
  readonly bots: Bots
  readonly memoryReviews: MemoryReviews
  readonly until: Until
  readonly lifecycle: TurnLifecycle
  readonly environments: Environments
  readonly sides: SideConversations
  readonly runners: Runners
  private readonly admissions: InputAdmissions

  constructor(
    private readonly member: Client,
    readonly identity: { agent: string; runner: string; workspace: string },
    private readonly base: () => AgentConfigurationInput,
    private readonly environment?: () => Record<string, JsonObject>,
    private readonly policy?: (workspace: string, conversation: string, preset?: string) => Promise<Preparation>,
    private readonly event?: (name: string, value: Schema.Json) => Promise<void>,
    mcp?: () => Promise<McpDirectory>,
    private readonly hooks?: ExtensionLifecycle,
    private readonly approvals?: { grant(value: ApprovalGrant): Promise<void>; list(): readonly ApprovalGrant[] },
    private readonly realtimeFactory?: () => RealtimeClient,
  ) {
    this.environments = new Environments(member, identity)
    this.runners = new Runners(member, identity.runner)
    this.operations = new Operations(member, this, identity)
    this.admissions = new InputAdmissions(member, hooks, async (input, notes) => {
      if (notes["nexus.until"]) await this.until.save(input.workspace, input.conversation, notes["nexus.until"])
      if (notes["nexus.side"]) {
        const side = Schema.decodeUnknownSync(
          Schema.Struct({ at: Schema.Number, model: Schema.optional(Schema.String) }),
        )(notes["nexus.side"])
        await this.sides.touch(input.workspace, input.conversation, side.at, side.model)
      }
      this.lifecycle.adopt(input.workspace, input.conversation)
    })
    this.presets = new Presets(member, mcp)
    this.bots = new Bots(member, this.presets, base, identity.runner, environment, event, this.admissions)
    this.memoryReviews = new MemoryReviews(member, identity.agent, event)
    this.until = new Until(member, identity.agent)
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
    }
  }

  realtime() {
    if (!this.realtimeFactory) throw new Error("Realtime subscriptions are unavailable.")
    return this.realtimeFactory()
  }

  async grantRule(value: ApprovalGrant) {
    if (!this.approvals) throw new Error("Session approval grants are unavailable.")

    await this.approvals.grant(value)
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

  async prepare(preset?: string, target?: { workspace: string; conversation: string }) {
    const base = this.base()
    const catalog = target ? await this.presets.catalog() : undefined
    const selected = catalog?.presets.find((entry) => entry.public_id === (preset ?? catalog.main_preset_public_id))
    const inherited =
      target &&
      (selected?.configuration.model_mode === "follow" || (!selected?.configuration.model && !base.default_model))
        ? await this.settledModel(target.workspace, target.conversation)
        : undefined
    const resolved = await this.presets.resolve(base, preset, inherited)

    return {
      agent_configuration: Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
      )(JSON.stringify({ ...resolved.configuration, system_prompt: { content: resolved.instructions } })),
      model: resolved.configuration.default_model ?? inherited,
      fallback_models: resolved.configuration.fallback_models ?? [],
    }
  }

  private async settledModel(workspace: string, conversation: string): Promise<string | undefined> {
    const scope = this.member.workspace(workspace)
    let before: number | undefined
    do {
      const page = await scope
        .conversation(conversation)
        .turns.list({ before_position: before, limit: 100, include_hidden: true })
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
      agent?: string
      restricted?: boolean
    },
    options: RequestOptions = {},
  ) {
    const workspace = input.workspace ?? this.identity.workspace
    const recipient = input.agent
      ? await addressedAgent(this.member, workspace, this.identity.agent, input.agent, options)
      : this.identity.agent
    const own = input.restricted
      ? (await this.member.workspace(workspace).principals(options)).find(
          (row) => row.public_id === this.identity.agent,
        )
      : undefined
    const result = await this.member.workspace(workspace).conversations.create(
      {
        answering_user_public_id: recipient,
        default_runner_executor_public_id:
          input.runner === undefined
            ? recipient === this.identity.agent
              ? await this.runners.default()
              : null
            : input.runner,
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
      },
      { ...options, idempotencyKey: input.key },
    )
    this.lifecycle.adopt(result.conversation.workspace_public_id, result.conversation.public_id)
    return result
  }

  async submit(
    input: {
      workspace: string
      conversation: string
      key: string
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
      model?: string
      preset?: string
      delivery?: CreateInput["delivery_mode"]
      executor_contexts?: Record<string, JsonObject>
      tools?: readonly string[]
      prepared?: Awaited<ReturnType<NexusApplication["prepare"]>>
      preparation?: () => Promise<Preparation>
    },
    author = this.member,
    options: RequestOptions = {},
  ) {
    return this.admissions.submit(
      {
        ...input,
        request: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
          JSON.stringify({ ...input, prepared: undefined, preparation: undefined }),
        ),
      },
      () => this.admit(input, author, options),
      author,
      options,
    )
  }

  private async admit(input: Parameters<NexusApplication["submit"]>[0], author: Client, options: RequestOptions) {
    const conversation = await author.workspace(input.workspace).conversation(input.conversation).fetch(options)

    const side = conversation.side ? await this.sides.read(input.workspace, input.conversation) : null
    const recipient = input.addressed
      ? await addressedAgent(
          author,
          input.workspace,
          this.identity.agent,
          input.answering_user_public_id ?? conversation.answering_user_public_id,
          options,
        )
      : undefined
    if (recipient && recipient !== this.identity.agent && !side) {
      if (conversation.archived_at || conversation.side)
        throw new Error("This conversation cannot receive addressed input.")
      if (input.until) throw new Error("Acceptance checks require this runtime's own agent.")
      return foreignInput(input, recipient)
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
    const previousSelection =
      !side && !input.model ? await this.admissions.modelSelection(input.workspace, input.conversation) : undefined
    const model = input.model ?? previousSelection?.model ?? side?.model ?? prepared.model

    if (!model && !inherited) throw new Error("Select a model before submitting input.")

    const tools = side
      ? await (async () => {
          if (foreignSide && side.tools === "write") return input.tools
          const assembly = await this.member.tools.assemble(
            {
              conversation_public_id: input.conversation,
              default_runner_executor_public_id: conversation.default_runner?.executor_public_id ?? null,
              ...(!inherited ? { configuration: prepared.agent_configuration } : {}),
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
              (modes.subagent ||
                !["spawn", "delegate_task", "nexus.conversation.spawn", "nexus.graph.delegate_task"].includes(
                  tool.canonical ?? name,
                )) &&
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
      : (input.tools ?? prepared.tools)
    const executor_contexts =
      input.executor_contexts ?? prepared.executor_contexts ?? (foreignSide ? undefined : this.environment?.())
    const instructions = Schema.decodeUnknownSync(
      Schema.Struct({ system_prompt: Schema.optional(Schema.Struct({ content: Schema.String })) }),
    )(prepared.agent_configuration).system_prompt?.content
    const acceptance = input.until
      ? await (async () => {
          const runner = conversation.default_runner?.executor_public_id
          if (!runner || !executor_contexts?.[runner])
            throw new Error("Acceptance checks require a captured runner environment.")
          if (
            (await author.workspace(input.workspace).conversation(input.conversation).turns.list({ limit: 1 }, options))
              .items.length
          )
            throw new Error("Start acceptance-check work in a new conversation.")
          const assembly = await this.member.tools.assemble(
            {
              conversation_public_id: input.conversation,
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
              instructions: [instructions, input.instructions, untilParagraph(policy)].filter(Boolean).join("\n\n"),
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
        : input.instructions
          ? { instructions: input.instructions }
          : {}),
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
            model_selection: previousSelection ?? {
              source: input.model ? ("explicit" as const) : ("default" as const),
              model: model!,
              constraint: input.model ? ("route" as const) : ("any" as const),
              alternatives: [],
            },
            fallback_models: prepared.fallback_models,
          }
        : input.model
          ? { model: { model: input.model } }
          : {}),
      delivery_mode: input.delivery,
      executor_contexts,
      ...(acceptance
        ? { ...acceptance, instructions: [input.instructions, acceptance.instructions].filter(Boolean).join("\n\n") }
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
      const snapshot = await execution.recover(options)

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
