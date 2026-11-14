import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { Nexus } from "@opencode/schema/nexus"
import { Configuration, redact, type ExtensionDescriptor } from "./configuration"
import type { RunnerContext, RunnerTool } from "./extensions"

export type ExtensionAPI = {
  directory: string
  signal: AbortSignal
  configuration: Record<string, Schema.Json>
  registerTool(tool: RunnerTool): void
  onShutdown(close: () => Promise<void> | void): void
  describeStatus(status: () => { ready: boolean; issues: string[] }): void
}
export type ExtensionModule = {
  descriptor: ExtensionDescriptor
  register(api: ExtensionAPI): Promise<void> | void
}
type Active = {
  tools: RunnerTool[]
  configuration: Record<string, Schema.Json>
  status(): { ready: boolean; issues: string[] }
  close(): Promise<void>
}

/** Registration is staged; failed candidates never replace a working extension. */
export class ExtensionManager {
  private active = new Map<string, Active>()
  private diagnostics = new Map<string, string[]>()
  private queue = Promise.resolve()
  private activation = Promise.resolve()

  constructor(
    private readonly configuration: Configuration,
    private readonly modules: readonly ExtensionModule[],
    private readonly directory: string,
    private readonly signal: AbortSignal,
    private readonly publish: () => Promise<void>,
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
        configuration_schema: descriptor.configuration_schema as Schema.Json,
        enabled: selected.enabled,
        active: !!active,
        ready: !!active && status.ready,
        restart_required:
          !!descriptor.restart_only &&
          (selected.enabled !== !!active ||
            JSON.stringify(selected.configuration) !== JSON.stringify(active?.configuration ?? selected.configuration)),
        configuration: redact(selected.configuration, descriptor.configuration_schema),
        diagnostics: [...(this.diagnostics.get(descriptor.id) ?? []), ...status.issues],
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

  private async apply(module: ExtensionModule) {
    const id = module.descriptor.id
    const selected = this.configuration.selection(module.descriptor)
    const previous = this.active.get(id)

    if (!selected.enabled) {
      this.active.delete(id)
      await previous?.close()
      this.diagnostics.delete(id)
      return
    }

    const absent = (module.descriptor.requires ?? []).filter((required) => !this.active.has(required))

    if (absent.length) throw new Error("Unavailable dependencies: " + absent.join(", "))

    const owner = new AbortController()
    const tools: RunnerTool[] = []
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
    const registering = Promise.resolve().then(() =>
      module.register({
        directory: this.directory,
        signal: AbortSignal.any([this.signal, owner.signal]),
        configuration: structuredClone(selected.configuration),
        registerTool: (tool) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12(tool.definition.input_schema ?? { type: "object" }),
          )

          tools.push({
            ...tool,
            execute: async (value, context: RunnerContext) => {
              if (lifecycle.retired) throw new Error("The extension owning this tool has retired.")

              context.signal.throwIfAborted()

              lifecycle.leases++

              try {
                return await tool.execute(value, context)
              } finally {
                lifecycle.leases--
                if (lifecycle.retired && !lifecycle.leases) lifecycle.finish()
              }
            },
          })
        },
        onShutdown: (handler) => {
          if (lifecycle.committed) throw new Error("Extension registration has finished.")
          cleanup.push(handler)
        },
        describeStatus: (read) => {
          status.read = read
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

    this.active.set(id, { tools, configuration: selected.configuration, status: () => status.read(), close })
    this.diagnostics.delete(id)
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
