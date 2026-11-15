import type { mcpSession } from "./mcp-session"
import { Schema } from "effect"
import { compileToolSchema, toolInputRefusal } from "./tool-schema"
import { WebUIModule } from "./webui-module"
import type { Nexus } from "@opencode/schema/nexus"
import {
  Configuration,
  publicConfigurationSchema,
  redact,
  validateConfiguration,
  type ExtensionDescriptor,
} from "./configuration"
import type { RunnerContext, RunnerTool } from "./extensions"
import type { NexusApplication } from "./application"
import type { AnnouncedTool, CommitTask, JsonObject } from "@cybros/agent"
import { TurnDraft, TurnRefusal, isTurnGate, type TurnFollow, type TurnGate } from "./extension-lifecycle"

export type ExtensionDocument = {
  name: string
  description: string
  role: "agent" | "runner" | "tool_provider"
  load(context: RunnerContext): Promise<Omit<CommitTask, "claim_token">>
}

export type ToolCall = { tool: AnnouncedTool; input: JsonObject; context: RunnerContext }
export type ToolDecision = { rewrite: JsonObject } | { veto: string } | void
export type ToolResult = ToolCall & { result: Omit<CommitTask, "claim_token"> }
export type ExtensionCommand = { description?: string; input_schema?: JsonObject }
export type ExtensionAgent = {
  name: string
  description: string
  display_name?: string
  system_prompt: string
  configuration: JsonObject & { default_model?: string | null }
}
export type ConversationServers = (input: Parameters<typeof mcpSession>[0]) => ReturnType<typeof mcpSession>

export type ExtensionAPI = {
  directory: string
  signal: AbortSignal
  configuration: Record<string, Schema.Json>
  application(): NexusApplication
  announced?(role: "agent" | "runner" | "tool_provider"): AnnouncedTool[]
  configure(operations: Nexus.ExtensionChange["operations"]): Promise<Nexus.ConfigurationResult>
  registerWebUI(root: string): Promise<void>
  registerTool(tool: RunnerTool): void
  registerCommand(name: string, handler: (input: Schema.Json) => Promise<Schema.Json>, options?: ExtensionCommand): void
  registerAgent(agent: ExtensionAgent): void
  registerConversationServers(handler: ConversationServers): void
  restartOnly(): void
  onStartup(start: () => Promise<void> | void): void
  background(name: string, run: (signal: AbortSignal) => Promise<void>): void
  registerDocument(document: ExtensionDocument): void
  on<E extends string>(
    event: E,
    handler: (
      payload: E extends "experimental.tool.call"
        ? ToolCall
        : E extends "experimental.tool.result"
          ? ToolResult
          : Schema.Json,
    ) => Promise<unknown> | unknown,
  ): void
  onShutdown(close: () => Promise<void> | void): void
  onToolResult(handler: ToolResultHandler): void
  describeStatus(status: () => { ready: boolean; issues: string[] }): void
  describeEnvironment(handler: (environment: JsonObject) => Promise<string | undefined> | string | undefined): void
}
export type ExtensionModule = {
  descriptor: ExtensionDescriptor
  register(api: ExtensionAPI): Promise<void> | void
}
type Active = {
  webui?: WebUIModule
  tools: RunnerTool[]
  leasedTools: RunnerTool[]
  commands: Map<string, (input: Schema.Json) => Promise<Schema.Json>>
  documents: ExtensionDocument[]
  hooks: Map<string, Array<(payload: unknown) => Promise<unknown>>>
  commandInfo: Map<string, ExtensionCommand>
  agents: ExtensionAgent[]
  servers?: ConversationServers
  restartOnly: boolean
  acquire(): () => void
  environments: Array<(environment: JsonObject) => Promise<string | undefined>>
  results: ToolResultHandler[]
  configuration: Record<string, Schema.Json>
  status(): { ready: boolean; issues: string[] }
  close(): Promise<void>
}
type ToolResultHandler = (
  context: Pick<RunnerContext, "workspace" | "conversation" | "run"> & Partial<RunnerContext>,
  result: Omit<CommitTask, "claim_token">,
) => Promise<Omit<CommitTask, "claim_token">> | Omit<CommitTask, "claim_token">

const ToolAnswer = Schema.Struct({
  content: Schema.optional(Schema.MutableJson),
  is_error: Schema.optional(Schema.Boolean),
  structured_content: Schema.optional(Schema.MutableJson),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  outcome: Schema.optional(Schema.Literals(["completed", "failed"])),
  title: Schema.optional(Schema.String),
  result_type: Schema.optional(Schema.String),
})
const AgentDefinition = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{1,31}$/)),
  description: Schema.NonEmptyString,
  display_name: Schema.optional(Schema.String),
  system_prompt: Schema.String,
  configuration: Schema.StructWithRest(
    Schema.Struct({ default_model: Schema.optional(Schema.NullOr(Schema.String)) }),
    [Schema.Record(Schema.String, Schema.MutableJson)],
  ),
})

/** Registration is staged; failed candidates never replace a working extension. */
export class ExtensionManager {
  private active = new Map<string, Active>()
  private diagnostics = new Map<string, string[]>()
  private queue = Promise.resolve()
  private activation = Promise.resolve()
  private restart = new Set<string>()
  private connection?: Schema.Json

  constructor(
    private readonly configuration: Configuration,
    private modules: readonly ExtensionModule[],
    private directory: string,
    private readonly signal: AbortSignal,
    private readonly publish: () => Promise<void>,
    private readonly application: () => NexusApplication = () => {
      throw new Error("The Nexus application is disconnected.")
    },
    private readonly baseTools: (role: "agent" | "runner" | "tool_provider") => readonly AnnouncedTool[] = () => [],
  ) {
    if (new Set(modules.map((module) => module.descriptor.id)).size !== modules.length)
      throw new Error("Duplicate Nexus extension IDs.")
  }

  async start() {
    await this.configuration.restore()

    const remaining = new Set(this.modules)

    while (remaining.size) {
      const available = [...remaining].filter((module) =>
        (module.descriptor.requires ?? []).every((id) => ![...remaining].some((row) => row.descriptor.id === id)),
      )

      if (!available.length) {
        for (const module of remaining) this.diagnostics.set(module.descriptor.id, ["Cyclic extension dependencies."])
        break
      }

      for (const module of available) {
        remaining.delete(module)
        await this.apply(module).catch((error: unknown) => {
          this.diagnostics.set(module.descriptor.id, [error instanceof Error ? error.message : "Extension failed."])
        })
      }
    }
  }

  tools() {
    return [...this.active.values()].flatMap((state) => state.tools)
  }

  setDirectory(directory: string, commit: () => Promise<void>) {
    const pending = this.queue.then(async () => {
      await this.activation
      const previous = this.directory
      this.directory = directory
      const skills = this.modules.find((module) => module.descriptor.id === "nexus.skills")
      await (skills ? this.apply(skills, undefined, commit) : commit()).catch((error: unknown) => {
        this.directory = previous
        throw error
      })
    })
    this.queue = pending.then(
      () => {},
      () => {},
    )
    return pending
  }

  agents() {
    return [...this.active.values()].flatMap((state) => state.agents)
  }

  conversationServers() {
    return [...this.active.values()].find((state) => state.servers)?.servers
  }

  captureTools() {
    const states = [...this.active.entries()]
    const releases = states.map(([, state]) => state.acquire())
    return {
      tools: states.flatMap(([, state]) => state.leasedTools),
      before: async (call: ToolCall): Promise<{ input: JsonObject } | { veto: string }> => {
        let input = call.input
        for (const [id, state] of states) {
          for (const handler of state.hooks.get("experimental.tool.call") ?? []) {
            const answer = await Promise.resolve()
              .then(() => handler({ ...call, input }))
              .catch((error: unknown) => {
                call.context.signal.throwIfAborted()
                this.diagnostics.set(id, [error instanceof Error ? error.message : "Tool hook failed."])
                return { veto: "blocked by " + id + ": tool hook failed" }
              })
            call.context.signal.throwIfAborted()
            if (answer === undefined || answer === null) continue
            const decision = Schema.decodeUnknownOption(
              Schema.Union([
                Schema.Struct({ veto: Schema.String }),
                Schema.Struct({ rewrite: Schema.Record(Schema.String, Schema.MutableJson) }),
              ]),
            )(answer)
            if (decision._tag === "None") return { veto: "blocked by " + id + ": invalid tool hook decision" }
            if ("veto" in decision.value) return { veto: decision.value.veto }
            input = decision.value.rewrite
          }
        }
        return { input }
      },
      after: async (call: ToolResult): Promise<Omit<CommitTask, "claim_token">> => {
        let result = call.result
        for (const [id, state] of states) {
          const handlers = [
            ...(state.hooks.get("experimental.tool.result") ?? []).map((handler) => () => handler({ ...call, result })),
            ...state.results.map((handler) => () => handler(call.context, result)),
          ]
          for (const handler of handlers) {
            const answer = await Promise.resolve()
              .then(handler)
              .catch((error: unknown) => {
                call.context.signal.throwIfAborted()
                this.diagnostics.set(id, [error instanceof Error ? error.message : "Result hook failed."])
              })
            call.context.signal.throwIfAborted()
            const parsed = Schema.decodeUnknownOption(ToolAnswer)(answer)
            if (parsed._tag === "Some") result = parsed.value
          }
        }
        return result
      },
      release: () => releases.toReversed().forEach((release) => release()),
    }
  }

  async toolResult(
    context: Pick<RunnerContext, "workspace" | "conversation" | "run">,
    initial: Omit<CommitTask, "claim_token">,
  ) {
    const states = [...this.active.entries()]
    const releases = states.map(([, state]) => state.acquire())
    let result = initial
    try {
      for (const [id, state] of states) {
        for (const handler of state.results) {
          const answer = await Promise.resolve()
            .then(() => handler(context, result))
            .catch((error: unknown) => {
              this.signal.throwIfAborted()
              this.diagnostics.set(id, [error instanceof Error ? error.message : "Result hook failed."])
            })
          const parsed = Schema.decodeUnknownOption(ToolAnswer)(answer)
          if (parsed._tag === "Some") result = parsed.value
        }
      }
      return result
    } finally {
      releases.toReversed().forEach((release) => release())
    }
  }

  replace(
    module: ExtensionModule,
    selection: { enabled: boolean; configuration: Record<string, Schema.Json>; source: Record<string, Schema.Json> },
  ) {
    const operation = this.queue.then(async () => {
      await this.activation
      const existing = this.modules.find((entry) => entry.descriptor.id === module.descriptor.id)

      if (existing && !this.configuration.saved(module.descriptor.id)?.source)
        throw new Error("This extension already has another source.")

      validateConfiguration(module.descriptor, selection.configuration)

      if (
        (module.descriptor.restart_only || this.active.get(module.descriptor.id)?.restartOnly) &&
        this.active.has(module.descriptor.id)
      ) {
        await this.configuration.replace(module.descriptor, selection)
        this.modules = this.modules.filter((entry) => entry.descriptor.id !== module.descriptor.id).concat(module)
        this.restart.add(module.descriptor.id)
        return { restart_required: true }
      }

      await this.apply(module, selection, async () => {
        await this.publish()
        await this.configuration.replace(module.descriptor, selection)
      })
      this.modules = this.modules.filter((entry) => entry.descriptor.id !== module.descriptor.id).concat(module)
      this.restart.delete(module.descriptor.id)
      return { restart_required: false }
    })

    this.queue = operation.then(
      () => {},
      () => {},
    )
    return operation
  }

  documents() {
    return [...this.active.values()].flatMap((state) => state.documents)
  }

  async readDocument(name: string, context: RunnerContext, role?: "agent" | "runner" | "tool_provider") {
    const document = this.documents().find((document) => document.name === name && (!role || role === document.role))

    if (!document) throw new Error("This extension document is not loaded: " + name)

    return document.load(context)
  }

  async emit(event: string, payload: Schema.Json) {
    if (event === "member.connected") this.connection = payload
    if (event === "member.disconnected") this.connection = undefined
    // A hook observes the already committed event. One extension's failure cannot undo it.
    await Promise.all(
      [...this.active.entries()].map(async ([id, state]) => {
        const results = await Promise.allSettled((state.hooks.get(event) ?? []).map((handler) => handler(payload)))
        const failed = results.filter((result) => result.status === "rejected")

        if (failed.length)
          this.diagnostics.set(
            id,
            failed.map((result) => (result.reason instanceof Error ? result.reason.message : "Extension hook failed.")),
          )
      }),
    )
  }

  async author(initial: TurnDraft): Promise<TurnDraft> {
    let draft = structuredClone(initial)
    for (const [id, state] of this.active) {
      for (const handler of state.hooks.get("turn.author") ?? []) {
        const answer = await handler(draft).catch((error: unknown) => {
          throw new Error(
            "Input authoring failed in " + id + ": " + (error instanceof Error ? error.message : "Extension failed."),
          )
        })
        const refusal = Schema.decodeUnknownOption(TurnRefusal)(answer)
        if (refusal._tag === "Some") throw new Error(refusal.value.reason)
        draft = Schema.decodeUnknownSync(TurnDraft)(answer)
      }
    }
    return draft
  }

  async follow(value: TurnFollow): Promise<TurnGate | undefined> {
    let selected: TurnGate | undefined
    for (const [id, state] of this.active) {
      for (const handler of state.hooks.get("turn.follow") ?? []) {
        await handler(value)
          .then(async (answer) => {
            if (answer === undefined || answer === null) return
            if (!isTurnGate(answer)) throw new Error("turn.follow must return a gate or nothing.")
            if (!selected) {
              selected = answer
              return
            }
            await answer.cancel?.()
            this.diagnostics.set(id, ["Another extension already installed a follow gate for this execution."])
          })
          .catch((error: unknown) =>
            this.diagnostics.set(id, [error instanceof Error ? error.message : "Follow hook failed."]),
          )
      }
    }
    return selected
  }

  async bindings(value: { workspace: string; conversation: string }) {
    const bindings: JsonObject[] = []
    for (const [id, state] of this.active) {
      for (const handler of state.hooks.get("conversation.binding") ?? []) {
        await handler(value)
          .then((answer) => {
            if (answer !== undefined && answer !== null)
              bindings.push(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(answer))
          })
          .catch((error: unknown) =>
            this.diagnostics.set(id, [error instanceof Error ? error.message : "Binding hook failed."]),
          )
      }
    }
    return bindings
  }

  async describeEnvironment(environment: JsonObject) {
    const descriptions: string[] = []
    for (const [id, state] of this.active) {
      for (const handler of state.environments) {
        await handler(environment)
          .then((value) => {
            if (value) descriptions.push(value)
          })
          .catch((error: unknown) =>
            this.diagnostics.set(id, [error instanceof Error ? error.message : "Environment description failed."]),
          )
      }
    }
    return descriptions.join("\n\n")
  }

  async command(name: string, input: Schema.Json) {
    const handler = [...this.active.values()].map((active) => active.commands.get(name)).find((handler) => handler)
    if (!handler) throw new Error("This extension command is not loaded: " + name)
    return handler(input)
  }

  async asset(id: string, version: string, path: string) {
    const module = this.active.get(id)?.webui
    if (!module || module.version !== version) throw new Error("This extension UI is no longer active.")
    return module.read(path)
  }

  list(): Nexus.Extension[] {
    return this.modules.map((module) => {
      const descriptor = module.descriptor
      const active = this.active.get(descriptor.id)
      const selected = this.selection(module)
      const status = active?.status() ?? { ready: false, issues: [] }

      return {
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
        configuration_version: descriptor.configuration_version,
        configuration_schema: Schema.decodeUnknownSync(Schema.Json)(
          publicConfigurationSchema(descriptor.configuration_schema),
        ),
        enabled: selected.enabled,
        active: !!active,
        ready: !!active && status.ready,
        restart_required:
          this.restart.has(descriptor.id) ||
          (!!(descriptor.restart_only || active?.restartOnly) &&
            (selected.enabled !== !!active ||
              JSON.stringify(selected.configuration) !==
                JSON.stringify(active?.configuration ?? selected.configuration))),
        configuration: redact(selected.configuration, descriptor.configuration_schema),
        diagnostics: [
          ...(this.diagnostics.get(descriptor.id) ?? []),
          ...this.configuration
            .diagnostics(descriptor)
            .map((issue) => issue.path.join(".") + ": " + issue.reason + " (" + issue.fallback + ")"),
          ...status.issues,
        ],
        tools: active?.tools.map((tool) => tool.definition.name) ?? [],
        commands: [...(active?.commands.keys() ?? [])],
        command_details: [...(active?.commandInfo ?? [])].map(([name, options]) => ({ name, ...options })),
        agents: active?.agents.map((agent) => agent.name) ?? [],
        requires: [...(descriptor.requires ?? [])],
        source: this.configuration.saved(descriptor.id)?.source,
        webui: active?.webui ? { version: active.webui.version, entry: "index.js" } : undefined,
      }
    })
  }

  change(input: Nexus.ExtensionChange): Promise<Nexus.ConfigurationResult> {
    const pending = this.queue.then(async () => {
      const module = this.modules.find((row) => row.descriptor.id === input.id)

      if (!module) throw new Error("Unknown Nexus extension: " + input.id)
      if (input.enabled === false) {
        const dependents = this.modules.filter(
          (row) => row.descriptor.requires?.includes(input.id) && this.selection(row).enabled,
        )

        if (dependents.length)
          throw new Error(
            "Disable dependent extensions first: " + dependents.map((row) => row.descriptor.id).join(", "),
          )
      }

      await this.configuration.change(module.descriptor, input)
      void this.emit("configuration.changed", { id: input.id, ...this.configuration.selection(module.descriptor) })

      if ((module.descriptor.restart_only || this.active.get(input.id)?.restartOnly) && this.active.has(input.id))
        return { saved: true, applied: false, published: false, restart_required: true }

      // HTTP configuration writes admit activation; status reads always return what is loaded now.
      this.activation = this.activation
        .then(async () => {
          await this.apply(module)
          await this.publish()
        })
        .catch((error: unknown) => {
          this.diagnostics.set(input.id, [error instanceof Error ? error.message : "Extension activation failed."])
        })

      return { saved: true, applied: false, published: false, restart_required: false }
    })

    this.queue = pending.then(
      () => {},
      () => {},
    )

    return pending
  }

  private selection(module: ExtensionModule) {
    try {
      return this.configuration.selection(module.descriptor)
    } catch (error) {
      this.diagnostics.set(module.descriptor.id, [error instanceof Error ? error.message : "Invalid configuration."])
      return { enabled: module.descriptor.default_enabled, configuration: module.descriptor.defaults }
    }
  }

  private async apply(
    module: ExtensionModule,
    override?: { enabled: boolean; configuration: Record<string, Schema.Json> },
    commit?: () => Promise<void>,
  ) {
    const id = module.descriptor.id
    const selected = override ?? this.configuration.selection(module.descriptor)
    const previous = this.active.get(id)

    if (!selected.enabled) {
      this.active.delete(id)
      await commit?.().catch((error: unknown) => {
        if (previous) this.active.set(id, previous)
        throw error
      })
      await previous?.close()
      this.diagnostics.delete(id)
      return
    }

    const absent = (module.descriptor.requires ?? []).filter((required) => !this.active.has(required))

    if (absent.length) throw new Error("Unavailable dependencies: " + absent.join(", "))

    const owner = new AbortController()
    const tools: RunnerTool[] = []
    const leasedTools: RunnerTool[] = []
    const commands = new Map<string, (input: Schema.Json) => Promise<Schema.Json>>()
    const documents: ExtensionDocument[] = []
    const hooks = new Map<string, Array<(payload: unknown) => Promise<unknown>>>()
    const commandInfo = new Map<string, ExtensionCommand>()
    const agents: ExtensionAgent[] = []
    const registrar: { open?: ConversationServers } = {}
    const startup: Array<() => Promise<void> | void> = []
    const backgrounds = new Map<string, (signal: AbortSignal) => Promise<void>>()
    const activity = new AbortController()
    const backgroundWork = new Set<Promise<void>>()
    const environments: Array<(environment: JsonObject) => Promise<string | undefined>> = []
    const results: ToolResultHandler[] = []
    const cleanup: Array<() => Promise<void> | void> = []
    const ui: { module?: WebUIModule } = {}
    const status = { read: () => ({ ready: true, issues: [] as string[] }) }
    const lifecycle = { restartOnly: false, committed: false, retired: false, leases: 0, finish: () => {} }
    const drained = new Promise<void>((resolve) => {
      lifecycle.finish = resolve
    })
    const close = async () => {
      lifecycle.retired = true
      activity.abort()
      await Promise.allSettled(backgroundWork)
      if (lifecycle.leases) await drained
      owner.abort()
      await Promise.allSettled(cleanup.toReversed().map((handler) => Promise.resolve().then(handler)))
    }
    const acquire = () => {
      if (lifecycle.retired) throw new Error("The extension owning this handler has retired.")
      lifecycle.leases++
      let released = false
      return () => {
        if (released) return
        released = true
        lifecycle.leases--
        if (lifecycle.retired && !lifecycle.leases) lifecycle.finish()
      }
    }
    const use = async <A>(handler: () => Promise<A>) => {
      if (lifecycle.retired) throw new Error("The extension owning this handler has retired.")
      lifecycle.leases++
      try {
        return await handler()
      } finally {
        lifecycle.leases--
        if (lifecycle.retired && !lifecycle.leases) lifecycle.finish()
      }
    }
    const registering = Promise.resolve().then(() =>
      module.register({
        directory: this.directory,
        signal: AbortSignal.any([this.signal, owner.signal]),
        configuration: structuredClone(selected.configuration),
        application: this.application,
        announced: (role) => [
          ...this.baseTools(role),
          ...[...this.active.entries()]
            .filter(([key]) => key !== id)
            .flatMap(([, state]) => state.tools)
            .concat(tools)
            .filter((tool) => (tool.role ?? "runner") === role)
            .map((tool) => tool.definition),
        ],
        configure: (operations) => this.change({ id, operations }),
        registerWebUI: async (root) => {
          if (lifecycle.committed || ui.module)
            throw new Error("Extension UI registration has finished or is duplicated.")
          const module = await WebUIModule.open(root)
          if (lifecycle.committed || ui.module) throw new Error("Await registerWebUI during extension registration.")
          ui.module = module
        },
        registerTool: (tool) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          if (tool.environmentRequired !== undefined && typeof tool.environmentRequired !== "boolean")
            throw new Error("Tool environmentRequired must be a boolean.")
          compileToolSchema(tool.definition.input_schema ?? { type: "object" })

          leasedTools.push(tool)
          tools.push({
            ...tool,
            execute: async (value, context: RunnerContext) => {
              context.signal.throwIfAborted()
              return use(() => tool.execute(value, context))
            },
          })
        },
        registerCommand: (name, handler, options = {}) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name) || commands.has(name))
            throw new Error("Invalid or duplicate extension command: " + name)
          const validator = options.input_schema ? compileToolSchema(options.input_schema) : undefined
          commandInfo.set(name, options)
          commands.set(name, (input) =>
            use(() => {
              const invalid = validator && toolInputRefusal(validator, input)
              if (invalid) throw new Error(invalid)
              return handler(input)
            }),
          )
        },
        registerAgent: (agent) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          const parsed = Schema.decodeUnknownSync(AgentDefinition)(agent)
          if (parsed.name.startsWith("bot-")) throw new Error("Extension agents cannot use the reserved bot- prefix.")
          if (agents.some((row) => row.name === parsed.name))
            throw new Error("Duplicate extension agent: " + parsed.name)
          agents.push(parsed)
        },
        registerConversationServers: (handler) => {
          if (lifecycle.committed || registrar.open)
            throw new Error("Conversation server registration has finished or is duplicated.")
          registrar.open = async (input) => {
            const release = acquire()
            try {
              const signal = AbortSignal.any([input.signal, activity.signal])
              const opened = await handler({ ...input, signal })
              const state: { closing?: Promise<void> } = {}
              const close = () =>
                (state.closing ??= Promise.resolve()
                  .then(() => opened.close())
                  .finally(() => {
                    signal.removeEventListener("abort", abort)
                    release()
                  }))
              const abort = () => {
                void close().catch(() => {})
              }
              signal.addEventListener("abort", abort, { once: true })
              if (signal.aborted) {
                await close()
                signal.throwIfAborted()
              }
              return { ...opened, close }
            } catch (error) {
              // Opening failed before a set could own the registration lease.
              release()
              throw error
            }
          }
        },
        restartOnly: () => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          lifecycle.restartOnly = true
        },
        onStartup: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          startup.push(handler)
        },
        background: (name, handler) => {
          if (lifecycle.committed || backgrounds.has(name))
            throw new Error("Background registration has finished or is duplicated.")
          backgrounds.set(name, handler)
        },
        registerDocument: (document) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          if (!document.name || documents.some((row) => row.name === document.name))
            throw new Error("Invalid or duplicate extension document: " + document.name)

          documents.push({ ...document, load: (context) => use(() => document.load(context)) })
        },
        on: (event, handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          if (!/^[a-z][a-z0-9._-]{0,63}$/.test(event)) throw new Error("Invalid extension event: " + event)

          hooks.set(event, [
            ...(hooks.get(event) ?? []),
            (payload) => {
              const call = async () => {
                const answer = await (handler as (payload: unknown) => unknown)(payload)
                if (event !== "turn.follow" || !isTurnGate(answer)) return answer
                lifecycle.leases++
                let released = false
                return {
                  ...(answer.run_public_id ? { run_public_id: answer.run_public_id } : {}),
                  reconsider: answer.reconsider.bind(answer),
                  cancel: async () => {
                    if (released) return
                    released = true
                    try {
                      await answer.cancel?.()
                    } finally {
                      lifecycle.leases--
                      if (lifecycle.retired && !lifecycle.leases) lifecycle.finish()
                    }
                  },
                } satisfies TurnGate
              }
              return event.startsWith("experimental.tool.") ? call() : use(call)
            },
          ])
        },
        onShutdown: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          cleanup.push(handler)
        },
        onToolResult: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          results.push((context, result) => Promise.resolve(handler(context, result)))
        },
        describeStatus: (read) => {
          status.read = read
        },
        describeEnvironment: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          environments.push((environment) => use(() => Promise.resolve(handler(environment))))
        },
      }),
    )

    await Promise.resolve(registering).catch(async (error: unknown) => {
      lifecycle.committed = true
      await close()
      throw error
    })

    lifecycle.committed = true

    const resources = new Map<string, number>()

    for (const tool of [...this.active.entries()]
      .filter(([key]) => key !== id)
      .flatMap(([, state]) => state.tools)
      .concat(tools)) {
      if (!tool.resource) continue
      if (
        !Number.isSafeInteger(tool.resource.concurrency) ||
        tool.resource.concurrency < 1 ||
        (resources.has(tool.resource.name) && resources.get(tool.resource.name) !== tool.resource.concurrency)
      ) {
        await close()
        throw new Error("Inconsistent resource concurrency: " + tool.resource.name)
      }

      resources.set(tool.resource.name, tool.resource.concurrency)
    }

    const names = [...this.active.entries()]
      .filter(([key]) => key !== id)
      .flatMap(([, active]) => active.tools.map((tool) => tool.definition.name))

    if (
      tools.some(
        (tool, index) =>
          names.includes(tool.definition.name) ||
          tools.slice(0, index).some((row) => row.definition.name === tool.definition.name),
      )
    ) {
      await close()
      throw new Error("Nexus extensions must provide unique tool names.")
    }

    const duplicate = [...this.active.entries()]
      .filter(([key]) => key !== id)
      .flatMap(([, active]) => [...active.commands.keys()])
      .find((name) => commands.has(name))
    if (duplicate) {
      await close()
      throw new Error("Duplicate extension command: " + duplicate)
    }
    const documentNames = [...this.active.entries()]
      .filter(([key]) => key !== id)
      .flatMap(([, state]) => state.documents.map((document) => document.name))
    if (documents.some((document) => documentNames.includes(document.name))) {
      await close()
      throw new Error("Duplicate extension document.")
    }

    const siblings = [...this.active.entries()].filter(([key]) => key !== id).map(([, state]) => state)
    if (
      (registrar.open && siblings.some((state) => state.servers)) ||
      agents.some((agent) => siblings.some((state) => state.agents.some((row) => row.name === agent.name)))
    ) {
      await close()
      throw new Error("Duplicate extension agent or conversation server registrar.")
    }
    await Promise.all(startup.map((handler) => Promise.resolve().then(handler))).catch(async (error: unknown) => {
      await close()
      throw error
    })
    this.active.set(id, {
      webui: ui.module,
      tools,
      leasedTools,
      commands,
      documents,
      hooks,
      environments,
      results,
      commandInfo,
      agents,
      servers: registrar.open,
      acquire,
      restartOnly: lifecycle.restartOnly,
      configuration: selected.configuration,
      status: () => status.read(),
      close,
    })
    await commit?.().catch(async (error: unknown) => {
      if (previous) this.active.set(id, previous)
      else this.active.delete(id)
      await close()
      await this.publish().catch(() => {})
      throw error
    })
    this.diagnostics.delete(id)
    for (const [name, handler] of backgrounds) {
      const running = Promise.resolve()
        .then(() => handler(AbortSignal.any([this.signal, activity.signal])))
        .catch((error: unknown) => {
          if (!activity.signal.aborted)
            this.diagnostics.set(id, [
              name + ": " + (error instanceof Error ? error.message : "Background activity failed."),
            ])
        })
      backgroundWork.add(running)
      void running.finally(() => backgroundWork.delete(running))
    }
    if (this.connection !== undefined) {
      const connected = this.connection
      void Promise.allSettled((hooks.get("member.connected") ?? []).map((handler) => handler(connected))).then(
        (results) => {
          const failed = results.filter((result) => result.status === "rejected")
          if (failed.length)
            this.diagnostics.set(
              id,
              failed.map((result) =>
                result.reason instanceof Error ? result.reason.message : "Connection hook failed.",
              ),
            )
        },
      )
    }
    // Accepted handlers retain their old instance until their real exit.
    void previous?.close()
  }

  async close() {
    await this.queue
    await this.activation
    await Promise.allSettled([...this.active.values()].map((state) => state.close()))
    this.active.clear()
  }
}
