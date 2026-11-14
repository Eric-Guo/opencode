import { JsonSchema, Schema, SchemaRepresentation } from "effect"
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
  role: "agent" | "runner"
  load(context: RunnerContext): Promise<Omit<CommitTask, "claim_token">>
}

export type ExtensionAPI = {
  directory: string
  signal: AbortSignal
  configuration: Record<string, Schema.Json>
  application(): NexusApplication
  announced?(role: "agent" | "runner"): AnnouncedTool[]
  configure(operations: Nexus.ExtensionChange["operations"]): Promise<Nexus.ConfigurationResult>
  registerTool(tool: RunnerTool): void
  registerCommand(name: string, handler: (input: Schema.Json) => Promise<Schema.Json>): void
  registerDocument(document: ExtensionDocument): void
  on(event: string, handler: (payload: Schema.Json) => Promise<unknown> | unknown): void
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
  tools: RunnerTool[]
  commands: Map<string, (input: Schema.Json) => Promise<Schema.Json>>
  documents: ExtensionDocument[]
  hooks: Map<string, Array<(payload: Schema.Json) => Promise<unknown>>>
  environments: Array<(environment: JsonObject) => Promise<string | undefined>>
  results: ToolResultHandler[]
  configuration: Record<string, Schema.Json>
  status(): { ready: boolean; issues: string[] }
  close(): Promise<void>
}
type ToolResultHandler = (
  context: Pick<RunnerContext, "workspace" | "conversation" | "run">,
  result: Omit<CommitTask, "claim_token">,
) => Promise<Omit<CommitTask, "claim_token">> | Omit<CommitTask, "claim_token">

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
    private readonly baseTools: (role: "agent" | "runner") => readonly AnnouncedTool[] = () => [],
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

  async toolResult(
    context: Pick<RunnerContext, "workspace" | "conversation" | "run">,
    initial: Omit<CommitTask, "claim_token">,
  ) {
    let result = initial
    for (const state of this.active.values()) {
      for (const handler of state.results) result = await handler(context, result)
    }
    return result
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

      if (module.descriptor.restart_only && this.active.has(module.descriptor.id)) {
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

  async readDocument(name: string, context: RunnerContext, role?: "agent" | "runner") {
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
          (!!descriptor.restart_only &&
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

      if (module.descriptor.restart_only && this.active.has(input.id))
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
    const commands = new Map<string, (input: Schema.Json) => Promise<Schema.Json>>()
    const documents: ExtensionDocument[] = []
    const hooks = new Map<string, Array<(payload: Schema.Json) => Promise<unknown>>>()
    const environments: Array<(environment: JsonObject) => Promise<string | undefined>> = []
    const results: ToolResultHandler[] = []
    const cleanup: Array<() => Promise<void> | void> = []
    const status = { read: () => ({ ready: true, issues: [] as string[] }) }
    const lifecycle = { committed: false, retired: false, leases: 0, finish: () => {} }
    const drained = new Promise<void>((resolve) => {
      lifecycle.finish = resolve
    })
    const close = async () => {
      lifecycle.retired = true
      if (lifecycle.leases) await drained
      owner.abort()
      await Promise.allSettled(cleanup.toReversed().map((handler) => Promise.resolve().then(handler)))
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
        registerTool: (tool) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12(tool.definition.input_schema ?? { type: "object" }),
          )

          tools.push({
            ...tool,
            execute: async (value, context: RunnerContext) => {
              context.signal.throwIfAborted()
              return use(() => tool.execute(value, context))
            },
          })
        },
        registerCommand: (name, handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name) || commands.has(name))
            throw new Error("Invalid or duplicate extension command: " + name)
          commands.set(name, (input) => use(() => handler(input)))
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
            (payload) =>
              use(async () => {
                const answer = await handler(payload)
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
              }),
          ])
        },
        onShutdown: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          cleanup.push(handler)
        },
        onToolResult: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          results.push((context, result) => use(() => Promise.resolve(handler(context, result))))
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

    this.active.set(id, {
      tools,
      commands,
      documents,
      hooks,
      environments,
      results,
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
