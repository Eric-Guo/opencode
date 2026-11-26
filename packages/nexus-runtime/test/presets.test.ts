import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { toolAlias } from "@cybros/agent"
import { StoreDocument } from "../src/document"
import { guidance, Presets } from "../src/presets"
import { readPreset, writePreset } from "../src/preset-document"
import { storeFixture } from "./fixture/store"

test("portable Presets preserve authored configuration without identity and accept agent Markdown", () => {
  const authored = {
    name: "Writer",
    description: "Write reports",
    configuration: {
      system_prompt: "Keep ${VARIABLE} literal.\n",
      model: null,
      model_mode: "follow" as const,
      fallback_models: [],
      tools: null,
    },
  }

  for (const format of ["md", "json"] as const)
    expect(readPreset(writePreset(authored, format), format)).toEqual(authored)

  expect(
    readPreset(
      "---\ndescription: Inspect code\nmodel: inherit\ntools: read, grep\n---\nInspect only.\n",
      "md",
      "explorer.md",
    ),
  ).toEqual({
    name: "explorer",
    description: "Inspect code",
    configuration: { model: null, model_mode: "follow", tools: ["read", "grep"], system_prompt: "Inspect only.\n" },
  })
  expect(() => readPreset('{"name":"x","description":"x","configuration":{},"public_id":"identity"}', "json")).toThrow(
    "Unsupported Preset fields",
  )
  expect(() => readPreset("---\nname: x\ndescription: &text words\nconfiguration: *text\n---\n", "md")).toThrow()
})

test("project imports use the first valid selected file and portable exports round-trip through the catalog", async () => {
  const fixture = storeFixture()
  const presets = new Presets(fixture.client)
  const root = await mkdtemp(join(tmpdir(), "nexus-project-presets-"))
  try {
    const first = join(root, ".agents/agents")
    const second = join(root, ".claude/agents")
    await mkdir(join(first, "nested"), { recursive: true })
    await mkdir(second, { recursive: true })
    const value = {
      description: "Review",
      configuration: { system_prompt: "你好\n", fallback_models: [], tools: null },
    }
    await Bun.write(join(first, "bad.md"), "---\nname: Later\ndescription: []\n---\n")
    await Bun.write(join(first, "Checker.json"), JSON.stringify(value))
    await Bun.write(join(first, "nested", "Deep.json"), JSON.stringify(value))
    await Bun.write(join(first, "Notes.txt"), JSON.stringify(value))
    await Bun.write(join(second, "Checker.json"), JSON.stringify({ description: "Second" }))
    await Bun.write(join(second, "Later.json"), JSON.stringify(value))
    await Bun.write(join(second, "Other.json"), JSON.stringify(value))
    const names = ["Checker", "Later", "Deep", "Notes"]
    const result = await presets.command({ action: "preset.import-project", names }, root)
    expect(result).toMatchObject({
      imported: [
        { name: "Checker", ...value },
        { name: "Later", ...value },
      ],
      skipped: [{ path: join(first, "bad.md"), reason: expect.any(String) }],
      missing: ["Deep", "Notes"],
    })
    expect((await presets.catalog()).presets.some((entry) => entry.name === "Other")).toBe(false)
    const saved = (await presets.catalog()).presets.at(-1)!
    for (const format of ["md", "json"] as const) {
      const content = await presets.command({ action: "preset.export-document", id: saved.public_id, format })
      expect(typeof content).toBe("string")
      const entry = await presets.command({
        action: "preset.import-document",
        name: "Copy",
        format,
        content: String(content),
      })
      expect(entry).toMatchObject({ name: "Copy", ...value, role: null })
    }
    for (const dir of [undefined, join(root, "absent")]) {
      expect(await presets.command({ action: "preset.import-project", names }, dir)).toEqual({
        imported: [],
        skipped: [],
        missing: names,
      })
    }
    expect(await presets.command({ action: "preset.import-project" }, root)).toMatchObject({
      imported: [{ name: "Checker" }, { name: "Later" }, { name: "Other" }],
    })
  } finally {
    fixture.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("Preset defaults change atomically and importing a document never publishes its role", async () => {
  const fixture = storeFixture()
  const presets = new Presets(fixture.client)

  try {
    const original = await presets.catalog()
    const content = writePreset({ name: "New", description: "Imported", configuration: { fallback_models: [] } }, "md")

    await presets.command({ action: "preset.import-document", format: "md", content })
    const imported = (await presets.catalog()).presets.at(-1)!

    expect(imported.role).toBeNull()
    await expect(
      presets.command({
        action: "preset.defaults",
        main_preset_public_id: imported.public_id,
        default_bot_preset_public_id: "missing",
      }),
    ).rejects.toThrow("Unknown Preset")
    expect((await presets.catalog()).main_preset_public_id).toBe(original.main_preset_public_id)
    await presets.command({
      action: "preset.defaults",
      main_preset_public_id: imported.public_id,
      default_bot_preset_public_id: imported.public_id,
    })
    expect(await new Presets(fixture.client).catalog()).toMatchObject({
      main_preset_public_id: imported.public_id,
      default_bot_preset_public_id: imported.public_id,
    })
  } finally {
    fixture.server.stop(true)
  }
})

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
      "Personal",
      "Peer",
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

test("seeds describe the personal superagent, the scoped peer and generalized roles", async () => {
  const fixture = storeFixture()
  const presets = new Presets(fixture.client)

  try {
    const catalog = await presets.catalog()
    const [personal, peer, worker, planner, explorer, reviewer] = catalog.presets

    expect(personal).toMatchObject({
      name: "Personal",
      description: "Act as the owner's personal superagent across conversations, channels, memory, routines and environments.",
      role: null,
      configuration: { model_mode: "default" },
    })
    expect(personal.configuration.system_prompt).toContain("take as little of their attention as possible")
    expect(personal.configuration.system_prompt).toContain("Ground recalls in your memory directory and session history.")
    expect(peer).toMatchObject({
      name: "Peer",
      description: "Represent a scoped peer or channel bot for a specific audience, group or repository.",
      role: null,
      configuration: { model_mode: "default" },
    })
    expect(peer.configuration.system_prompt).toContain("hand back out-of-scope follow-ups rather than guessing authority")
    expect(worker).toMatchObject({
      description: "Carry out a bounded research, writing, operational or implementation task.",
      role: {
        name: "worker",
        description: "Choose for ordinary execution of a bounded research, writing, operational or implementation task.",
      },
      configuration: { model_mode: "follow" },
    })
    expect(worker.configuration.system_prompt).toContain("Report the deliverable, verification evidence and any unresolved blocker to the delegator.")
    expect(planner).toMatchObject({
      description: "Turn a goal and constraints into a concrete, verifiable plan.",
      role: {
        name: "planner",
        description: "Choose when requirements, dependencies or execution order need investigation before acting.",
      },
      configuration: { model_mode: "follow", runner_tool_names: ["read", "grep", "ls", "find", "web_fetch"] },
    })
    expect(planner.configuration.system_prompt).toContain("Cite the evidence behind assumptions.")
    expect(explorer).toMatchObject({
      description: "Inspect documents, web sources, codebases or environments and report grounded findings.",
      role: {
        name: "explorer",
        description: "Choose for focused document, web, codebase or environment investigation and evidence gathering.",
      },
      configuration: { model_mode: "follow", runner_tool_names: ["read", "grep", "ls", "find", "web_fetch"] },
    })
    expect(explorer.configuration.system_prompt).toContain("Do not modify the material being inspected.")
    expect(reviewer).toMatchObject({
      description: "Assess supplied work or deliverables for concrete defects and missing verification.",
      role: {
        name: "reviewer",
        description: "Choose to review a completed deliverable or change for defects, regressions and gaps in verification.",
      },
      configuration: { model_mode: "follow", runner_tool_names: ["read", "grep", "ls", "find", "bash", "web_fetch"] },
    })
    expect(reviewer.configuration.system_prompt).toContain("distinguish defects from preferences")
  } finally {
    fixture.server.stop(true)
  }
})

test("shared guidance carries the attention doctrine and the run-declaration guideline", () => {
  expect(guidance).toContain("Take as little human attention as possible, and give as much value as possible.")
  expect(guidance).toContain("Speak proactively only for a brief acknowledgement, a ready deliverable, a direct answer, or one concrete blocking decision")
  expect(guidance).toContain("hand it back once with a concise reason")
  expect(guidance).toContain("Choose an environment when creating work that touches files, processes or a browser; pure personal, memory, research or coordination work needs no bound directory")
  expect(guidance).toContain("draft it with `propose_skill` so they can review and publish it")
  expect(guidance).toContain("out-of-scope follow-up handbacks with `channel_dispatch`")
  expect(guidance).toContain("reading multiple documents, searching memory, fetching pages or running checks")
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
      tool_definitions: [
        toolAlias("spawn_agent", "nexus.conversation.spawn", {
          omit: ["wait"],
          params: { recipient: { maps_to: "agent" } },
        }),
      ],
      compaction_policy: { mode: "kernel" },
    })

    expect(captured.configuration.fallback_models).toEqual([])
    expect(captured.configuration.runner_tool_names).toEqual(["read"])
    const spawn = {
      function: { name: "spawn_agent" },
      params: { recipient: { maps_to: "declaration", description: expect.stringContaining("worker") } },
      omit: ["wait", "agent"],
    }

    expect(captured.configuration.tool_definitions).toMatchObject([spawn])
    expect(captured.summarizer).toContain("Goal:")
    expect(captured.configuration.delegation_catalog).toHaveLength(4)
    expect(captured.configuration.delegation_catalog![0]).toMatchObject({
      declaration: {
        conversation_reach: "subtree",
        tool_definitions: [spawn],
        summarizer: { content: expect.stringContaining("Goal:") },
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
