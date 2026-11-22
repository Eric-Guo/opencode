import { readFile, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Schema } from "effect"
import type { ExtensionModule } from "./extension-manager"

const Environment = Schema.Struct({
  root: Schema.String,
  working_directory: Schema.optional(Schema.String),
  fs: Schema.optional(Schema.Struct({ client: Schema.String, read: Schema.Boolean, write: Schema.Boolean })),
})

export function conventionsExtension(home?: string): ExtensionModule {
  return {
    descriptor: {
      id: "nexus.conventions",
      name: "Repository conventions",
      description: "Capture repository and installation instructions when authoring work.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: { type: "object", properties: {}, additionalProperties: false },
      defaults: {},
    },
    register(api) {
      api.describeEnvironment(async (environment) => {
        const context =
          typeof environment.root === "string" ? environment : environment[api.application().identity.runner]
        if (!context || typeof context !== "object" || Array.isArray(context)) return
        const root = context["opencode.directory"] ?? context.root
        const fields = context["opencode.environment"] ?? context["rho.environment"] ?? (root ? { root } : undefined)
        if (!fields) return
        const captured = Schema.decodeUnknownSync(Environment)(fields)
        const block = await conventions(captured.working_directory ?? captured.root, captured.root, home)
        const editor =
          context["opencode.editor"] || captured.fs
            ? "The editor's open buffers are what read, edit and write see; grep, glob, ls and shell commands see the disk — use edit or write for files open in the editor; a shell write to a file with unsaved changes is invisible to read."
            : undefined
        return [block, editor].filter(Boolean).join("\n\n") || undefined
      })
    },
  }
}

export async function conventions(directory: string, root: string, home?: string, budget = 32768) {
  const paths: string[] = []
  for (let current = resolve(directory), depth = 0; depth < 32; current = dirname(current), depth++) {
    paths.push(join(current, "AGENTS.md"), join(current, "CLAUDE.md"))
    if (current === resolve(root) || current === dirname(current)) break
  }
  if (home && !paths.includes(join(resolve(home), "AGENTS.md"))) paths.push(join(resolve(home), "AGENTS.md"))
  const files = (
    await Promise.all(
      paths.map(async (path) => {
        return (async () =>
          (await stat(path)).isFile() ? { path, text: await readFile(path, "utf8") } : undefined)().catch(
          () => undefined,
        )
      }),
    )
  ).filter((file) => file !== undefined)
  if (!files.length) return
  const remaining = { bytes: budget }
  const sections = files
    .map((file) => {
      const header = `--- ${file.path} ---\n`
      const bytes = Buffer.from(file.text.trim())
      if (Buffer.byteLength(header) + bytes.length <= remaining.bytes) {
        remaining.bytes -= Buffer.byteLength(header) + bytes.length
        return header + bytes.toString("utf8")
      }
      const notice = (omitted: number) =>
        `\n[…${omitted} more bytes of ${basename(file.path)} omitted: the conventions budget is ${budget} bytes]`
      const keep = Math.max(remaining.bytes - Buffer.byteLength(header) - Buffer.byteLength(notice(bytes.length)), 0)
      const text = new TextDecoder().decode(bytes.subarray(0, keep), { stream: true })
      remaining.bytes = 0
      return header + text + notice(bytes.length - Buffer.byteLength(text))
    })
    .reverse()
  return ["Repository conventions the operator asks you to follow, from the files below:", ...sections].join("\n\n")
}
