import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { parseDocument } from "yaml"
import { toolAlias, type Client } from "@cybros/agent"
import type { NexusSettings } from "@opencode/schema/nexus-settings"
import data from "./adaptation-data.json"
import { missing } from "./storage"

// MIT-licensed reference data from Cybros a91c63f44a0571f2a6cf08b85d7e568964441183,
// sdks/ruby/lib/cybros_agent/model_adaptations. Nexus owns schema assembly.
const Alias = Schema.Struct({
  name: Schema.NonEmptyString,
  canonical: Schema.NonEmptyString,
  params: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        maps_to: Schema.String,
        invert: Schema.optional(Schema.Boolean),
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
  omit: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
  recut: Schema.optional(Schema.Struct({ anchor: Schema.NonEmptyString, replacement: Schema.String })),
})
const Row = Schema.Struct({
  format: Schema.Literal(1),
  row: Schema.NonEmptyString,
  models: Schema.Array(Schema.NonEmptyString),
  tool_style: Schema.Array(Schema.Literals(["nexus", "claude", "codex"])),
  tool_descriptions: Schema.optional(Schema.Array(Alias)),
  summarizer_prompt: Schema.optional(Schema.NullOr(Schema.String)),
  lead_hints: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, text: Schema.String }))),
})
type Row = typeof Row.Type & { source: "bundled" | "local"; path?: string }

export class Adaptations {
  private constructor(
    readonly rows: Row[],
    private readonly settings: NexusSettings.Values,
    private readonly model?: string,
  ) {}

  static async load(settings: NexusSettings.Values, directory: string, model?: string) {
    const root = settings.adaptations_dir ?? join(directory, "adaptations")
    const files = await readdir(root).catch((error) => {
      if (missing(error)) return []
      throw error
    })
    const local = await Promise.all(
      files
        .filter((file) => file.endsWith(".yml"))
        .sort()
        .map(async (file): Promise<Row> => {
          const path = join(root, file)
          const document = parseDocument(await readFile(path, "utf8"), { schema: "core" })
          if (document.errors.length) throw new Error(path + ": " + document.errors[0].message)
          const row = Schema.decodeUnknownSync(Row, { onExcessProperty: "error" })(document.toJS({ maxAliasCount: 0 }))
          if (row.row !== file.slice(0, -4)) throw new Error(path + ": row must match the file name")
          row.models.forEach(validatePattern)
          return { ...row, source: "local", path }
        }),
    )
    const bundled: Row[] = data.rows.map((row) => ({ ...Schema.decodeUnknownSync(Row)(row), source: "bundled" }))

    for (const rows of [bundled, local]) {
      const patterns = new Map<string, Row>()

      for (const row of rows) {
        for (const pattern of row.models) {
          const prior = patterns.get(pattern)

          if (prior)
            throw new Error(
              (row.path ?? row.row) + ": model pattern " + pattern + " also appears in " + (prior.path ?? prior.row),
            )

          patterns.set(pattern, row)
        }
      }
    }
    const rows = bundled.filter((row) => !local.some((entry) => entry.row === row.row))
    const result = new Adaptations([...rows, ...local], settings, model)
    if (!["auto", "off"].includes(settings.adaptations) && !result.rows.some((row) => row.row === settings.adaptations))
      throw new Error("Unknown adaptation row: " + settings.adaptations)
    for (const row of result.rows) {
      const aliases = result.aliases(row)
      if (new Set(aliases.map((alias) => alias.name)).size !== aliases.length)
        throw new Error(row.row + ": duplicate alias")
      const hidden = result.hidden(row)
      for (const hint of row.lead_hints ?? [])
        if (
          [...hidden].some((canonical) =>
            hint.text.includes("`" + data.presets.plain[canonical as keyof typeof data.presets.plain] + "`"),
          )
        )
          throw new Error(row.row + ": hint names a superseded tool")
    }
    return result
  }

  private resolve(model = this.model) {
    const mode = this.settings.adaptations
    const fallback = this.rows.find((row) => row.row === "default")!
    if (mode === "off") return { row: fallback, matched: null, selection: "off" }
    if (mode === "auto" && model && !model.includes("/"))
      throw new Error("Model reference requires a lane segment: " + model)

    const reference = model?.includes("/") ? model.slice(model.indexOf("/") + 1) : undefined
    const rows = mode === "auto" ? this.rows : this.rows.filter((row) => row.row === mode)
    const ranked = rows
      .flatMap((row) =>
        row.models
          .filter((pattern) =>
            pattern.endsWith("*") ? reference?.startsWith(pattern.slice(0, -1)) : reference === pattern,
          )
          .map((pattern) => ({
            row,
            pattern,
            own: row.source === "local" && !data.rows.some((entry) => entry.row === row.row),
            rank: pattern.endsWith("*") ? pattern.length - 1 : pattern.length + 1,
          })),
      )
      .sort(
        (a, b) =>
          Number(b.own) - Number(a.own) ||
          b.rank - a.rank ||
          Number(b.row.source === "local") - Number(a.row.source === "local"),
      )
    const match = ranked[0]
    if (mode !== "auto") return { row: rows[0], matched: match?.pattern ?? null, selection: "pinned" }
    if (!match) return { row: fallback, matched: null, selection: "fallback" }

    return { row: match.row, matched: match.pattern, selection: match.pattern.endsWith("*") ? "wildcard" : "exact" }
  }

  choice(model = this.model) {
    return this.resolve(model).row
  }

  facts(model = this.model) {
    const { row, matched, selection } = this.resolve(model)
    const boot = this.choice()
    return {
      row: selection === "off" ? "off" : row.row,
      source: selection === "off" ? "off" : row.source,
      selection,
      matched,
      ...(selection !== "off" && {
        models: [...row.models],
        tool_style: [...row.tool_style],
        tool_descriptions: row.tool_descriptions?.length ?? 0,
        recuts: this.aliases(row).flatMap((alias) =>
          alias.recut ? [alias.name + " ← " + alias.recut.anchor.split("\n")[0]] : [],
        ),
        summarizer:
          row.summarizer_prompt == null
            ? "kernel default"
            : createHash("sha256").update(row.summarizer_prompt).digest("hex").slice(0, 12) +
              " " +
              Buffer.byteLength(row.summarizer_prompt) +
              " B (row)",
        lead_hints: (row.lead_hints ?? []).map((hint) => hint.id),
      }),
      ...(row.path ? { path: row.path } : {}),
      ...(row.row !== boot.row ? { boot_row: boot.row } : {}),
    }
  }

  hints(model?: string) {
    return this.settings.adaptations === "off"
      ? ""
      : (this.choice(model).lead_hints ?? []).map((hint) => hint.text).join("\n\n")
  }

  summarizer(model?: string) {
    return this.settings.adaptations === "off" ? null : (this.choice(model).summarizer_prompt ?? undefined)
  }

  configuration(names: string[], catalog: Awaited<ReturnType<Client["tools"]["list"]>>) {
    const row = this.choice()
    const off = this.settings.adaptations === "off"
    const hidden = off ? new Set<string>() : this.hidden(row)
    const kernel = names.filter((name) => !hidden.has(name))
    const skill = "nexus.skill.load"
    const aliases = (off ? [] : this.aliases(row))
      .filter((alias) => names.includes(alias.canonical))
      .map((alias) => {
        const template = catalog.find((tool) => tool.canonical_name === alias.canonical)?.template
        if (alias.recut && (!template || !template.includes(alias.recut.anchor)))
          throw new Error(alias.name + ": adaptation anchor moved")
        return toolAlias(alias.name, alias.canonical, {
          ...(alias.params ? { params: { ...alias.params } } : {}),
          ...(alias.omit ? { omit: [...alias.omit] } : {}),
          ...(alias.description || alias.recut
            ? { description: alias.description ?? template!.replace(alias.recut!.anchor, alias.recut!.replacement) }
            : {}),
          ...(alias.canonical === skill ? { defer_loading: true } : {}),
        })
      })
    const servedSkill = kernel.includes(skill) && catalog.find((tool) => tool.canonical_name === skill)

    // A same-name alias overrides the plain declaration during Nexus assembly.
    if (servedSkill && !aliases.some((alias) => alias.function.name === servedSkill.name))
      aliases.push(toolAlias(servedSkill.name, skill, { defer_loading: true }))

    return { kernel_tools: kernel, tool_definitions: aliases }
  }

  private aliases(row: Row) {
    return [
      ...data.presets.words
        .filter((word) => row.tool_style.includes(word as (typeof row.tool_style)[number]))
        .flatMap((word) =>
          Schema.decodeUnknownSync(Schema.Array(Alias))(
            data.presets.presets[word as keyof typeof data.presets.presets].aliases,
          ),
        ),
      ...(row.tool_descriptions ?? []),
    ]
  }

  private hidden(row: Row) {
    return new Set(
      row.tool_style.includes("nexus") ? [] : row.tool_style.flatMap((word) => data.presets.presets[word].supersedes),
    )
  }
}

function validatePattern(pattern: string) {
  const stem = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern
  if (
    !/^[!-~]+$/.test(pattern) ||
    /[?\[\]{}()|^$+\\]/.test(pattern) ||
    stem.includes("*") ||
    (pattern.endsWith("*") && !/[-_:/@]$/.test(stem)) ||
    /^\/|\/$|\/\//.test(pattern) ||
    !/[a-z0-9]/i.test(pattern)
  )
    throw new Error("Invalid model pattern: " + pattern)
}
