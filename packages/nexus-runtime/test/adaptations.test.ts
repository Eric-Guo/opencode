import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Adaptations } from "../src/adaptations"
import { ApplicationSettings, defaultSettings } from "../src/settings"
import data from "../src/adaptation-data.json"

test("adaptations select by lane-independent reference and apply boot aliases with anchored descriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-adaptations-"))
  try {
    const pack = await Adaptations.load(defaultSettings, directory, "openai_api/gpt-6.2-sol")
    for (const [model, row] of [
      ["codex_subscription/gpt-6.2-sol", "codex"],
      ["openai_api/gpt-6.1-terra", "codex"],
      ["openrouter/openai/gpt-6.2-astra", "codex"],
      ["anthropic/claude-sonnet-5-5", "claude"],
      ["openrouter/anthropic/claude-haiku-5.5", "claude"],
      ["openrouter/moonshotai/kimi-k3.1-pro", "kimi-k3"],
      ["moonshot/kimi-k3.1-pro-highspeed", "kimi-k3"],
      ["kimi_code/k3.1-pro-highspeed", "kimi-k3"],
      ["openai_api/gpt-6-astra", "default"],
      ["codex_subscription/gpt-6.1-sol", "default"],
      ["anthropic/claude-fable-5-1", "default"],
      ["openrouter/moonshotai/kimi-k3", "default"],
    ])
      expect(pack.facts(model)).toMatchObject({ row, source: "bundled" })

    expect(pack.facts("openrouter/moonshotai/kimi-k3.1-pro").boot_row).toBe("codex")
    expect(pack.facts("broker/z-ai/glm-5.3")).toMatchObject({ row: "glm-5.3", boot_row: "codex" })
    expect(pack.facts("broker/z-ai/glm-5.3-flash")).toMatchObject({ row: "default" })
    const catalog = data.presets.presets.codex.aliases.map((alias) => ({
      canonical_name: alias.canonical,
      name: alias.name,
      effect_profile: {},
      definition: {},
      template: alias.recut?.anchor ?? "Tool description",
    }))
    const result = pack.configuration(
      catalog.map((row) => row.canonical_name),
      catalog,
    )
    expect(result.kernel_tools).toEqual([])
    expect(result.tool_definitions.map((row) => row.function.name)).toEqual(["imagegen", "spawn_agent", "send_message"])
    expect(result.tool_definitions[1]).toMatchObject({
      canonical: "nexus.conversation.spawn",
      omit: ["wait"],
      description: expect.stringContaining("wake policy"),
    })
    expect(() => pack.configuration(["nexus.conversation.spawn"], [])).toThrow("anchor moved")
    const off = await Adaptations.load({ ...defaultSettings, adaptations: "off" }, directory)
    expect(off.facts("lane/other")).toMatchObject({ selection: "off", matched: null })
    expect(off.configuration(["nexus.conversation.spawn"], [])).toEqual({
      kernel_tools: ["nexus.conversation.spawn"],
      tool_definitions: [],
    })
    await expect(Adaptations.load({ ...defaultSettings, adaptations: "missing" }, directory)).rejects.toThrow(
      "Unknown adaptation",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("local adaptation rows override bundled rows, prioritize own patterns, and reject invalid configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-local-"))
  try {
    await mkdir(join(directory, "adaptations"))
    await writeFile(
      join(directory, "adaptations", "custom.yml"),
      "format: 1\nrow: custom\nmodels: [gpt-*, gpt-6.1-sol]\ntool_style: [nexus]\nlead_hints: [{id: plan, text: Custom hint}]\nsummarizer_prompt: Custom summary\n",
    )
    const pack = await Adaptations.load(defaultSettings, directory, "lane/gpt-6.1-sol")
    expect(pack.facts()).toMatchObject({ row: "custom", source: "local", selection: "exact", matched: "gpt-6.1-sol" })
    expect(pack.facts("lane/gpt-future")).toMatchObject({ selection: "wildcard", matched: "gpt-*" })
    expect(pack.facts("lane/unknown")).toMatchObject({ selection: "fallback" })
    const pinned = await Adaptations.load({ ...defaultSettings, adaptations: "custom" }, directory)
    expect(pinned.facts("lane/other")).toMatchObject({ selection: "pinned", matched: null })
    expect(pack.facts()).toMatchObject({
      models: ["gpt-*", "gpt-6.1-sol"],
      tool_style: ["nexus"],
      tool_descriptions: 0,
      lead_hints: ["plan"],
      summarizer: expect.stringMatching(/^[a-f0-9]{12} 14 B \(row\)$/),
    })
    expect(pack.hints()).toBe("Custom hint")
    expect(pack.summarizer()).toBe("Custom summary")
    const clash = join(directory, "adaptations", "same.yml")

    await writeFile(clash, "format: 1\nrow: same\nmodels: [gpt-*]\ntool_style: [nexus]\n")
    await expect(Adaptations.load(defaultSettings, directory)).rejects.toThrow(
      /same\.yml: model pattern gpt-\* also appears in .*custom\.yml/,
    )
    await rm(clash)
    await writeFile(
      join(directory, "adaptations", "custom.yml"),
      "format: 1\nrow: custom\nmodels: [gpt*]\ntool_style: [nexus]\n",
    )
    await expect(Adaptations.load(defaultSettings, directory)).rejects.toThrow("Invalid model pattern")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("skill loading follows the served name and defers both plain and adapted spellings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-skill-adaptation-"))
  const canonical = "nexus.skill.load"
  const catalog = [{ canonical_name: canonical, name: "load_skill", effect_profile: {}, definition: {}, template: null }]

  try {
    for (const adaptations of ["auto", "off", "claude"] as const) {
      const pack = await Adaptations.load({ ...defaultSettings, adaptations }, directory)
      const result = pack.configuration([canonical], catalog)

      expect(result.kernel_tools).toEqual(adaptations === "claude" ? [] : [canonical])
      expect(result.tool_definitions).toMatchObject([
        { canonical, function: { name: adaptations === "claude" ? "Skill" : "load_skill" }, defer_loading: true },
      ])
      expect(pack.configuration([], catalog).tool_definitions).toEqual([])
    }
    await mkdir(join(directory, "adaptations"))
    await writeFile(
      join(directory, "adaptations", "custom.yml"),
      "format: 1\nrow: custom\nmodels: [fixture]\ntool_style: [nexus]\n" +
        "tool_descriptions: [{name: load_skill, canonical: nexus.skill.load, description: Load a project skill.}]\n",
    )
    const custom = await Adaptations.load(defaultSettings, directory, "provider/fixture")

    expect(custom.configuration([canonical], catalog).tool_definitions).toMatchObject([
      { canonical, function: { name: "load_skill" }, defer_loading: true, description: "Load a project skill." },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("application settings validate before saving and retain independent choices after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-settings-"))
  try {
    const settings = new ApplicationSettings(join(directory, "settings.json"))
    await settings.restore()
    expect(settings.read().kernel_tools).toContain("nexus.models.list")
    expect(settings.read().kernel_tools).toContain("nexus.skill.load")
    await settings.change({ subagent_default: false, fallback_models: ["lane/model"] }, async () => {})
    await expect(
      settings.change({ adaptations: "bad" }, async () => {
        throw new Error("Invalid row")
      }),
    ).rejects.toThrow("Invalid row")
    const restarted = new ApplicationSettings(join(directory, "settings.json"))
    await restarted.restore()
    expect(restarted.read()).toMatchObject({
      subagent_default: false,
      fallback_models: ["lane/model"],
      adaptations: "auto",
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
