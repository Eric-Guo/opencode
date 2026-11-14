import { basename, extname } from "node:path"
import { parseDocument } from "yaml"
import { Schema } from "effect"
import { NexusPreset } from "@opencode/schema/nexus-preset"

export function readPreset(content: string, format: "md" | "json", filename = "preset.md") {
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Preset document exceeds 1 MiB.")

  const front = format === "md" ? /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content) : null
  const fields =
    format === "json"
      ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(content)
      : (() => {
          if (!front) throw new Error("A Markdown Preset requires YAML frontmatter.")
          const document = parseDocument(front[1], { schema: "core" })

          if (document.errors.length) throw new Error("Invalid Preset YAML: " + document.errors[0].message)
          return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
            document.toJS({ maxAliasCount: 0 }),
          )
        })()
  const nested = Object.hasOwn(fields, "configuration")
  const allowed = nested
    ? ["name", "description", "configuration"]
    : [
        "name",
        "description",
        "system_prompt",
        "model",
        "model_mode",
        "fallback_models",
        "tools",
        "runner_tool_names",
        "mcp",
        "prompt_template",
      ]
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key))

  if (unknown.length) throw new Error("Unsupported Preset fields: " + unknown.join(", "))

  const configuration = nested
    ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(fields.configuration)
    : Object.fromEntries(Object.entries(fields).filter(([key]) => !["name", "description"].includes(key)))

  if (!nested) {
    for (const key of ["tools", "runner_tool_names"]) {
      const value = configuration[key]

      if (typeof value === "string")
        configuration[key] = value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
    }
    if (configuration.model === "inherit") {
      configuration.model = null
      configuration.model_mode = "follow"
    }
  }

  const body = front ? content.slice(front[0].length) : undefined
  if (body) configuration.system_prompt = body

  return Schema.decodeUnknownSync(NexusPreset.Authored, { onExcessProperty: "error" })({
    name: fields.name ?? basename(filename, extname(filename)),
    description: fields.description,
    configuration,
  })
}

export function writePreset(entry: NexusPreset.Authored, format: "md" | "json") {
  const fields = { name: entry.name, description: entry.description, configuration: { ...entry.configuration } }

  if (format === "json") return JSON.stringify(fields, null, 2) + "\n"

  const prompt = fields.configuration.system_prompt ?? ""
  delete fields.configuration.system_prompt

  // JSON is valid YAML and preserves null inheritance and explicit empty lists without implicit scalar coercion.
  return "---\n" + JSON.stringify(fields, null, 2) + "\n---\n" + prompt
}
