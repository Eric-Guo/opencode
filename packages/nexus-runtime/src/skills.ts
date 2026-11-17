import { readFile, readdir, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { parseDocument } from "yaml"
import { Schema } from "effect"
import type { ExtensionModule } from "./extension-manager"
import { readWindow } from "./file-read"
import { missing } from "./storage"

export async function readSkill(path: string) {
  const text = await readFile(path, "utf8")
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!front) throw new Error("No frontmatter block.")
  const parsed = parseDocument(front[1], { schema: "core" })
  if (parsed.errors.length) throw new Error("Frontmatter did not parse: " + parsed.errors[0].message)
  const fields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
    parsed.toJS({ maxAliasCount: 0 }),
  )
  const name = basename(dirname(path))
  if (name.length > 64 || !/^[a-z0-9](?:-?[a-z0-9])*$/.test(name)) throw new Error("Invalid skill directory name.")
  if (fields.name != null && (typeof fields.name !== "string" || fields.name.trim() !== name))
    throw new Error("Skill name must match its directory.")
  if (
    typeof fields.description !== "string" ||
    !fields.description.trim() ||
    Buffer.byteLength(fields.description.trim()) > 1024
  )
    throw new Error("A skill needs a description of 1..1024 bytes.")
  return {
    name,
    description: fields.description.trim(),
    body: text.slice(front[0].length),
    directory: dirname(path),
    path,
    bodyLine: front[0].split("\n").length,
  }
}

export async function scanSkills(root: string) {
  const found = new Map<string, Awaited<ReturnType<typeof readSkill>>>()
  const skipped: { path: string; reason: string }[] = []
  for (const base of [".agents/skills", ".claude/skills"]) {
    const directory = join(root, base)
    const entries = await readdir(directory).catch((error) => {
      if (missing(error)) return []
      throw error
    })
    for (const name of entries.sort()) {
      const path = join(directory, name, "SKILL.md")
      const skill = await readSkill(path).catch((error: unknown) => {
        skipped.push({ path, reason: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      if (!skill) continue
      if (found.has(skill.name)) {
        skipped.push({ path, reason: "Skill name is already announced: " + name })
        continue
      }
      found.set(skill.name, skill)
    }
  }
  return { skills: [...found.values()], skipped }
}

export function skillsExtension(guide = "/usr/local/share/cybros/workspace-tools.md"): ExtensionModule {
  return {
    descriptor: {
      id: "nexus.skills",
      name: "Project skills",
      description: "Announce and load checkout skill documents.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: { type: "object", properties: {}, additionalProperties: false },
      defaults: {},
    },
    async register(api) {
      const discovered = await scanSkills(api.directory)
      const installed = await stat(guide).then(
        (info) => info.isFile(),
        () => false,
      )
      const catalog = discovered.skills.map((skill) => ({ name: skill.name, description: skill.description }))
      if (installed && !catalog.some((skill) => skill.name === "workspace-tools"))
        catalog.push({
          name: "workspace-tools",
          description:
            "Use the prepared coding runtimes, Office converters, Python document libraries, fonts and browser tools in this workspace's environment.",
        })
      for (const skill of catalog)
        api.registerDocument({
          name: skill.name,
          description: skill.description,
          role: "runner",
          async load(context) {
            context.signal.throwIfAborted()
            const current = (await scanSkills(api.directory)).skills.find((entry) => entry.name === skill.name)
            if (!current) {
              if (
                skill.name === "workspace-tools" &&
                (await stat(guide).then(
                  (info) => info.isFile(),
                  () => false,
                ))
              )
                return readWindow(guide, context.signal)
              return { is_error: true, content: "skill_unknown: " + skill.name }
            }
            const files =
              "Files for this skill are under " +
              current.directory +
              "; relative paths in the instructions are relative to it."
            if (!current.body) return { content: files }
            const result = await readWindow(current.path, context.signal, current.bodyLine)
            return { ...result, content: result.content + "\n\n" + files }
          },
        })
      api.describeStatus(() => ({
        ready: true,
        issues: discovered.skipped.map((entry) => entry.path + ": " + entry.reason),
      }))
    },
  }
}
