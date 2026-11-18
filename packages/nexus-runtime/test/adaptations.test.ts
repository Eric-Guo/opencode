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
    const pack = await Adaptations.load(defaultSettings, directory, "openai_api/gpt-6.1-sol")
    expect(pack.facts("other/gpt-6.1-sol")).toMatchObject({ row: "codex", source: "bundled" })
    expect(pack.facts("vipai/gpt-6.2-sol")).toMatchObject({ row: "codex", source: "bundled" })
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
      "format: 1\nrow: custom\nmodels: [gpt-*]\ntool_style: [nexus]\nlead_hints: [{id: plan, text: Custom hint}]\nsummarizer_prompt: Custom summary\n",
    )
    const pack = await Adaptations.load(defaultSettings, directory, "lane/gpt-6.1-sol")
    expect(pack.facts()).toMatchObject({ row: "custom", source: "local" })
    expect(pack.hints()).toBe("Custom hint")
    expect(pack.summarizer()).toBe("Custom summary")
    await writeFile(
      join(directory, "adaptations", "custom.yml"),
      "format: 1\nrow: custom\nmodels: [gpt*]\ntool_style: [nexus]\n",
    )
    await expect(Adaptations.load(defaultSettings, directory)).rejects.toThrow("Invalid model pattern")
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
