import type {
  AgentConfigurationInput,
  Client,
  CreateInput,
  ExecutionSnapshot,
  JsonObject,
  RequestOptions,
} from "@cybros/agent"
import { Schema } from "effect"
import { setTimeout as delay } from "node:timers/promises"
import { Presets } from "./presets"
import { Bots } from "./bots"
import { InputAdmissions } from "./admission"

type Preparation = {
  agent_configuration: JsonObject
  model?: string
  fallback_models: string[]
  tools?: readonly string[]
  executor_contexts?: Record<string, JsonObject>
}

/** Surface-independent admission and following. Nexus remains the durable execution owner. */
export class NexusApplication {
  readonly presets: Presets
  readonly bots: Bots
  private readonly admissions: InputAdmissions

  constructor(
    private readonly member: Client,
    private readonly identity: { agent: string; runner: string; workspace: string },
    private readonly base: () => AgentConfigurationInput,
    private readonly environment?: () => Record<string, JsonObject>,
  ) {
    this.admissions = new InputAdmissions(member)
    this.presets = new Presets(member)
    this.bots = new Bots(member, this.presets, base, identity.runner, environment)
  }

  async prepare(preset?: string) {
    const resolved = await this.presets.resolve(this.base(), preset)

    return {
      agent_configuration: Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
      )(JSON.stringify({ ...resolved.configuration, system_prompt: { content: resolved.instructions } })),
      model: resolved.configuration.default_model ?? undefined,
      fallback_models: resolved.configuration.fallback_models ?? [],
    }
  }

  async open(
    input: { key: string; title?: string; workspace?: string; runner?: string | null },
    options: RequestOptions = {},
  ) {
    return this.member.workspace(input.workspace ?? this.identity.workspace).conversations.create(
      {
        answering_user_public_id: this.identity.agent,
        default_runner_executor_public_id: input.runner === undefined ? this.identity.runner : input.runner,
        title: input.title,
      },
      { ...options, idempotencyKey: input.key },
    )
  }

  async submit(
    input: {
      workspace: string
      conversation: string
      key: string
      text: string
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

    if (conversation.answering_user_public_id !== this.identity.agent || conversation.archived_at || conversation.side)
      throw new Error("This conversation cannot receive Main Agent input.")

    const prepared: Preparation =
      input.prepared ?? (input.preparation ? await input.preparation() : await this.prepare(input.preset))
    const model = input.model ?? prepared.model

    if (!model) throw new Error("Select a model before submitting input.")

    const tools = input.tools ?? prepared.tools
    return {
      kind: "direct_reply",
      text: input.text,
      agent_configuration: prepared.agent_configuration,
      model: { model },
      model_selection: {
        source: input.model ? "explicit" : "default",
        model,
        constraint: input.model ? "route" : "any",
        alternatives: [],
      },
      fallback_models: prepared.fallback_models,
      delivery_mode: input.delivery,
      executor_contexts: input.executor_contexts ?? prepared.executor_contexts ?? this.environment?.(),
      ...(tools ? { tool_names: [...tools] } : {}),
    } satisfies CreateInput
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

      await delay(250, undefined, { signal: options.signal })
    }

    options.signal?.throwIfAborted()
  }
}
