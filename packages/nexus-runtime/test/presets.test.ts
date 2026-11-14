import { expect, test } from "bun:test"
import { Schema } from "effect"
import { StoreDocument } from "../src/document"
import { Presets } from "../src/presets"
import { storeFixture } from "./fixture/store"

test("Store documents reconcile a committed response loss and do not replay stale mutations", async () => {
  const fixture = storeFixture()
  const decode = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))
  const first = new StoreDocument(fixture.client.profile.storeEntries, "fixture", "counter", decode)
  const second = new StoreDocument(fixture.client.profile.storeEntries, "fixture", "counter", decode)

  try {
    await first.change(() => ({ count: 0 }))
    expect(await second.read()).toEqual({ count: 0 })
    fixture.state.loseResponse = true
    expect(await first.change((value) => ({ count: value!.count + 1 }))).toEqual({ count: 1 })
    expect(fixture.state.writes).toBe(2)
    await expect(second.change((value) => ({ count: value!.count + 4 }))).rejects.toThrow()
    expect(fixture.state.writes).toBe(2)
    expect(await second.read()).toEqual({ count: 1 })
  } finally {
    fixture.server.stop(true)
  }
})

test("Presets seed once, retain identity on replacement and export portable behavior without role publication", async () => {
  const fixture = storeFixture()
  const presets = new Presets(fixture.client)

  try {
    const catalog = await presets.catalog()

    expect(catalog.presets.map((row) => row.name)).toEqual([
      "Probius",
      "Adjutant",
      "worker",
      "planner",
      "explorer",
      "reviewer",
    ])
    expect(catalog.presets[0].public_id[14]).toBe("7")

    const original = await presets.command({
      action: "preset.create",
      value: {
        name: "Writer",
        description: "Write reports",
        configuration: { model: "provider/model", fallback_models: [] },
      },
    })

    expect(original).toHaveProperty("public_id")
    const id = (await presets.catalog()).presets.at(-1)!.public_id

    await presets.command({ action: "preset.publish", id, role: { name: "writer", description: "Write a report" } })
    const portable = await presets.command({ action: "preset.export", id })

    expect(portable).toEqual({
      name: "Writer",
      description: "Write reports",
      configuration: { model: "provider/model", fallback_models: [] },
    })
    await presets.command({
      action: "preset.replace",
      id,
      value: {
        name: "Editor",
        description: "Edit reports",
        configuration: { system_prompt: "  preserve\n whitespace  " },
      },
    })
    expect((await presets.catalog()).presets.at(-1)).toMatchObject({
      public_id: id,
      role: { name: "writer" },
      configuration: { system_prompt: "  preserve\n whitespace  " },
    })
    await presets.command({ action: "preset.remove", id })
    const restored = await new Presets(fixture.client).catalog()

    expect(restored.presets).toHaveLength(6)
    expect(fixture.state.writes).toBe(5)
    await expect(presets.command({ action: "preset.remove", id: catalog.main_preset_public_id })).rejects.toThrow(
      "default",
    )
  } finally {
    fixture.server.stop(true)
  }
})

test("Preset compilation captures independent fallback and tool policies with conversation-only child memory", async () => {
  const fixture = storeFixture()
  const presets = new Presets(fixture.client)

  try {
    const catalog = await presets.catalog()

    await presets.command({
      action: "preset.replace",
      id: catalog.main_preset_public_id,
      value: {
        name: "Main",
        description: "Main agent",
        configuration: { fallback_models: [], runner_tool_names: ["read", "not-available"], system_prompt: "Original" },
      },
    })
    const captured = await presets.resolve({
      default_model: "provider/base",
      fallback_models: ["provider/fallback"],
      runner_tool_names: ["read", "write"],
      kernel_tools: ["nexus.conversation.spawn"],
    })

    expect(captured.configuration.fallback_models).toEqual([])
    expect(captured.configuration.runner_tool_names).toEqual(["read"])
    expect(captured.configuration.delegation_catalog).toHaveLength(4)
    expect(captured.configuration.delegation_catalog![0]).toMatchObject({
      declaration: {
        conversation_reach: "subtree",
        memory_context_limit: {
          bindings: [{ name: "conversation", source: { scope: "conversation" }, access: "read_write" }],
        },
      },
    })
    await presets.command({
      action: "preset.replace",
      id: catalog.main_preset_public_id,
      value: { name: "Main", description: "Main agent", configuration: { system_prompt: "Changed" } },
    })
    expect(captured.instructions).toContain("Original")
    expect(captured.instructions).not.toContain("Changed")
    await presets.command({
      action: "preset.replace",
      id: catalog.main_preset_public_id,
      value: { name: "Main", description: "No delegation", configuration: { tools: [] } },
    })
    const restricted = await presets.resolve({ kernel_tools: ["nexus.conversation.spawn"] })

    expect(restricted.configuration.tool_definitions).toEqual([])
    await expect(
      presets.command({
        action: "preset.create",
        value: {
          name: "Invalid",
          description: "Invalid memory roots",
          configuration: {
            memory_context_limit: { bindings: [{ name: "agent", source: { scope: "agent" }, access: "read_write" }] },
          },
        },
      }),
    ).rejects.toThrow("natural roots")
  } finally {
    fixture.server.stop(true)
  }
})
