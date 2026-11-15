import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { Configuration } from "../src/configuration"
import { ExtensionManager, type ExtensionModule } from "../src/extension-manager"
import { definition } from "../src/extensions"

const descriptor = {
  id: "fixture",
  name: "Fixture",
  description: "A configured extension.",
  configuration_version: 1,
  default_enabled: true,
  configuration_schema: {
    type: "object",
    additionalProperties: false,
    properties: { token: { type: "string", writeOnly: true }, count: { type: "integer", minimum: 0 } },
    required: ["token", "count"],
  },
  defaults: { token: "", count: 1 },
} as const

test("extension announcement budgets include base, sibling and staged tools without a replaced generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-announcement-"))
  const inventories: string[][] = []
  const published = Promise.withResolvers<void>()
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor: { ...descriptor, id: "sibling" },
        register(api) {
          api.registerTool({
            definition: definition("sibling", "Sibling", {}, []),
            async execute() {
              return { content: "sibling" }
            },
          })
          api.registerTool({
            role: "agent",
            definition: definition("agent", "Agent", {}, []),
            async execute() {
              return { content: "agent" }
            },
          })
        },
      },
      {
        descriptor,
        register(api) {
          inventories.push(api.announced!("runner").map((tool) => tool.name))
          api.registerTool({
            definition: definition("own", "Own", {}, []),
            async execute() {
              return { content: "own" }
            },
          })
          inventories.push(api.announced!("runner").map((tool) => tool.name))
          expect(api.announced!("agent").map((tool) => tool.name)).toEqual(["agent"])
        },
      },
    ],
    directory,
    new AbortController().signal,
    async () => {
      published.resolve()
    },
    undefined,
    (role) => (role === "runner" ? [definition("base", "Base", {}, [])] : []),
  )
  try {
    await manager.start()
    await manager.change({ id: descriptor.id, operations: [{ op: "set", path: ["count"], value: 2 }] })
    await published.promise
    expect(inventories).toEqual([
      ["base", "sibling"],
      ["base", "sibling", "own"],
      ["base", "sibling"],
      ["base", "sibling", "own"],
    ])
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("configuration serializes writes, validates before saving, restores and redacts write-only fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-settings-"))
  const file = join(directory, "configuration.json")
  const configuration = new Configuration(file)

  try {
    await configuration.restore()
    await Promise.all([
      configuration.change(descriptor, {
        id: descriptor.id,
        operations: [{ op: "set", path: ["token"], value: "secret" }],
      }),
      configuration.change(descriptor, { id: descriptor.id, operations: [{ op: "set", path: ["count"], value: 3 }] }),
    ])

    const before = await readFile(file, "utf8")

    await expect(
      configuration.change(descriptor, {
        id: descriptor.id,
        operations: [{ op: "set", path: ["count"], value: -1 }],
      }),
    ).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe(before)

    const restored = new Configuration(file)

    await restored.restore()
    expect(restored.selection(descriptor)).toEqual({ enabled: true, configuration: { token: "secret", count: 3 } })

    const manager = new ExtensionManager(
      restored,
      [{ descriptor, register() {} }],
      directory,
      new AbortController().signal,
      async () => {},
    )

    await manager.start()
    expect(manager.list()[0].configuration).toEqual({ token: "[saved]", count: 3 })
    expect(Schema.decodeUnknownSync(Schema.Json)(manager.list())).toEqual(manager.list())
    expect(JSON.stringify(manager.list())).not.toContain("secret")
    await manager.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("disabled modules stay inert and failed registration releases staged resources without losing siblings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-extensions-"))
  const events: string[] = []
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor: { ...descriptor, id: "disabled", default_enabled: false },
        register() {
          throw new Error("must not run")
        },
      },
      {
        descriptor: { ...descriptor, id: "broken" },
        register(api) {
          api.onShutdown(() => {
            events.push("released")
          })
          api.registerTool({
            definition: definition("partial", "partial", {}, []),
            async execute() {
              return { content: "partial" }
            },
          })
          api.registerCommand("partial.command", async () => "partial")
          throw new Error("registration failed")
        },
      },
      {
        descriptor,
        register(api) {
          api.registerCommand("fixture.command", async () => "ok")
          api.registerTool({
            definition: definition("fixture", "fixture", {}, []),
            async execute() {
              return { content: "ok" }
            },
          })
        },
      },
    ],
    directory,
    new AbortController().signal,
    async () => {},
  )

  try {
    await manager.start()
    expect(manager.tools().map((tool) => tool.definition.name)).toEqual(["fixture"])
    expect(await manager.command("fixture.command", {})).toBe("ok")
    await expect(manager.command("partial.command", {})).rejects.toThrow("not loaded")
    expect(events).toEqual(["released"])
    expect(manager.list().find((row) => row.id === "broken")?.diagnostics).toEqual(["registration failed"])
    expect(manager.list().find((row) => row.id === "disabled")?.active).toBe(false)
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("configuration returns before activation, and replacement leases survive until handler exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-leases-"))
  const released: number[] = []
  const latch = Promise.withResolvers<void>()
  const published = Promise.withResolvers<void>()
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor,
        register(api) {
          const count = Number(api.configuration.count)

          api.registerCommand("fixture.command", async () => {
            await latch.promise
            return count
          })

          api.onShutdown(() => {
            released.push(count)
          })
          api.registerTool({
            definition: definition("fixture", "fixture", {}, []),
            async execute() {
              await latch.promise
              return { content: String(count) }
            },
          })
        },
      },
    ],
    directory,
    new AbortController().signal,
    async () => {
      published.resolve()
    },
  )

  try {
    await manager.start()

    const previous = manager.tools()[0]
    const call = previous.execute(
      {},
      { directory, workspace: "w", conversation: "c", run: "r", task: "t", signal: new AbortController().signal },
    )
    const command = manager.command("fixture.command", {})
    const result = await manager.change({ id: descriptor.id, operations: [{ op: "set", path: ["count"], value: 2 }] })

    expect(result).toEqual({ saved: true, applied: false, published: false, restart_required: false })
    await published.promise
    expect(released).toEqual([])
    latch.resolve()
    expect((await call).content).toBe("1")
    expect(await command).toBe(1)
    await manager.close()
    expect(released.toSorted()).toEqual([1, 2])
  } finally {
    latch.resolve()
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("restart-only changes persist without replacing active resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-restart-"))
  const module: ExtensionModule = { descriptor: { ...descriptor, restart_only: true }, register() {} }
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [module],
    directory,
    new AbortController().signal,
    async () => {},
  )

  try {
    await manager.start()
    expect(await manager.change({ id: descriptor.id, enabled: false })).toEqual({
      saved: true,
      applied: false,
      published: false,
      restart_required: true,
    })
    expect(manager.list()[0]).toMatchObject({ active: true, enabled: false, restart_required: true })
    await manager.close()

    const restored = new ExtensionManager(
      new Configuration(join(directory, "settings.json")),
      [module],
      directory,
      new AbortController().signal,
      async () => {},
    )

    await restored.start()
    expect(restored.list()[0]).toMatchObject({ active: false, enabled: false, restart_required: false })
    await restored.close()
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("tool hooks retain their pair across replacement and isolate gates and observer failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-tool-hooks-"))
  const seen: string[] = []
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [],
    directory,
    new AbortController().signal,
    async () => {},
  )
  const module = (label: string): ExtensionModule => ({
    descriptor,
    register(api) {
      api.onShutdown(() => {
        seen.push(label + ":closed")
      })
      api.on("experimental.tool.call", (call) => {
        seen.push(label + ":before")
        if (call.input.veto) return { veto: "refused" }
        if (call.input.fail) throw new Error("gate failed")
        return { rewrite: { value: label } }
      })
      api.on("experimental.tool.result", (call) => {
        seen.push(label + ":after")
        return { ...call.result, content: label }
      })
      api.on("experimental.tool.result", () => {
        throw new Error("observer failed")
      })
    },
  })
  const call = {
    tool: definition("probe", "Probe", {}, []),
    input: {},
    context: {
      directory,
      workspace: "w",
      conversation: "c",
      run: "r",
      task: "t",
      signal: new AbortController().signal,
    },
  }
  try {
    await manager.start()
    await manager.replace(module("old"), {
      enabled: true,
      configuration: descriptor.defaults,
      source: { kind: "package" },
    })
    const captured = manager.captureTools()
    expect(await captured.before(call)).toEqual({ input: { value: "old" } })
    await manager.replace(module("new"), {
      enabled: true,
      configuration: descriptor.defaults,
      source: { kind: "package" },
    })
    expect(seen).not.toContain("old:closed")
    expect(
      await captured.after({ ...call, result: { content: "original", metadata: { checkpoint: "kept" } } }),
    ).toEqual({ content: "old", metadata: { checkpoint: "kept" } })
    captured.release()
    const next = manager.captureTools()
    expect(await next.before(call)).toEqual({ input: { value: "new" } })
    expect(await next.before({ ...call, input: { veto: true } })).toEqual({ veto: "refused" })
    expect(await next.before({ ...call, input: { fail: true } })).toMatchObject({
      veto: expect.stringContaining("blocked by fixture"),
    })
    next.release()
    expect(seen.filter((entry) => entry.endsWith(":before") || entry.endsWith(":after"))).toEqual([
      "old:before",
      "old:after",
      "new:before",
      "new:before",
      "new:before",
    ])
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("staged startup, backgrounds, agents, commands and MCP registrars share publication and retirement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-registrations-"))
  const running = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const events: string[] = []
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [],
    directory,
    new AbortController().signal,
    async () => {},
  )
  const module: ExtensionModule = {
    descriptor,
    register(api) {
      api.onStartup(() => {
        events.push("startup")
      })
      api.background("poller", async (signal) => {
        expect(manager.agents()).toHaveLength(1)
        running.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              stopped.resolve()
              resolve()
            },
            { once: true },
          ),
        )
      })
      api.registerAgent({ name: "room", description: "Shared room", system_prompt: "Help", configuration: {} })
      api.registerCommand("fixture.echo", async (input) => input, {
        description: "Echo",
        input_schema: {
          type: "object",
          properties: { text: { type: "string", pattern: "^ok$" } },
          required: ["text"],
          additionalProperties: false,
          not: { properties: { text: { const: "blocked" } }, required: ["text"] },
        },
      })
      api.registerConversationServers(async () => ({
        tools: [],
        issues: [],
        close: async () => {
          events.push("servers:closed")
        },
      }))
    },
  }
  try {
    await manager.start()
    await manager.replace(module, { enabled: true, configuration: descriptor.defaults, source: { kind: "package" } })
    await running.promise
    expect(events).toEqual(["startup"])
    expect(manager.list()[0].command_details).toEqual([
      { name: "fixture.echo", description: "Echo", input_schema: expect.anything() },
    ])
    await expect(manager.command("fixture.echo", {})).rejects.toThrow()
    await expect(manager.command("fixture.echo", { text: "invalid" })).rejects.toThrow()
    await expect(manager.command("fixture.echo", { text: "ok", extra: true })).rejects.toThrow()
    expect(await manager.command("fixture.echo", { text: "ok" })).toEqual({ text: "ok" })
    expect(manager.conversationServers()).toBeFunction()
    await manager.conversationServers()!({
      workspace: "w",
      conversation: "c",
      directory,
      servers: [],
      signal: new AbortController().signal,
    })
    await expect(
      manager.replace(
        {
          descriptor: { ...descriptor, id: "duplicate" },
          register(api) {
            api.registerConversationServers(async () => ({ tools: [], issues: [], close: async () => {} }))
          },
        },
        { enabled: true, configuration: descriptor.defaults, source: { kind: "package" } },
      ),
    ).rejects.toThrow("registrar")
    await manager
      .replace(
        {
          descriptor,
          register(api) {
            api.registerAgent({ name: "partial", description: "Partial", system_prompt: "", configuration: {} })
            api.onStartup(() => {
              throw new Error("startup failed")
            })
          },
        },
        { enabled: true, configuration: descriptor.defaults, source: { kind: "package" } },
      )
      .then(
        () => {
          throw new Error("expected failure")
        },
        () => {},
      )
    expect(manager.agents().map((agent) => agent.name)).toEqual(["room"])
    await manager.change({ id: descriptor.id, enabled: false })
    await stopped.promise
    expect(events).toEqual(["startup", "servers:closed"])
    expect(manager.agents()).toEqual([])
    expect(manager.conversationServers()).toBeUndefined()
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an active extension can require restart based on its selected configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-restart-only-"))
  const registrations: number[] = []
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor,
        register(api) {
          api.restartOnly()
          registrations.push(Number(api.configuration.count))
          api.registerCommand("fixture.count", async () => api.configuration.count)
        },
      },
    ],
    directory,
    new AbortController().signal,
    async () => {},
  )
  try {
    await manager.start()
    expect(manager.list()[0].restart_required).toBe(false)
    expect(
      await manager.change({ id: descriptor.id, operations: [{ op: "set", path: ["count"], value: 2 }] }),
    ).toMatchObject({ saved: true, restart_required: true })
    expect(manager.list()[0].restart_required).toBe(true)
    expect(await manager.command("fixture.count", {})).toBe(1)
    await manager.change({ id: descriptor.id, enabled: false })
    expect(manager.list()[0].active).toBe(true)
    expect(registrations).toEqual([1])
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})
