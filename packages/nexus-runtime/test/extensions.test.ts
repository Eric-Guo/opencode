import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
          throw new Error("registration failed")
        },
      },
      {
        descriptor,
        register(api) {
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
    const result = await manager.change({ id: descriptor.id, operations: [{ op: "set", path: ["count"], value: 2 }] })

    expect(result).toEqual({ saved: true, applied: false, published: false, restart_required: false })
    await published.promise
    expect(released).toEqual([])
    latch.resolve()
    expect((await call).content).toBe("1")
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
