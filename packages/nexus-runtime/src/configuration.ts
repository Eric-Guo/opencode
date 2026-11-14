import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { Nexus } from "@opencode/schema/nexus"
import { atomic, missing } from "./storage"

const Selection = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  configuration_version: Schema.optional(Schema.Int),
  configuration: Schema.Record(Schema.String, Schema.Json),
})
const Document = Schema.Struct({
  version: Schema.Literal(1),
  extensions: Schema.Record(Schema.String, Selection),
})

export type ExtensionDescriptor = {
  id: string
  name: string
  description: string
  default_enabled: boolean
  configuration_version: number
  configuration_schema: JsonSchema.JsonSchema
  defaults: Record<string, Schema.Json>
  requires?: readonly string[]
  restart_only?: boolean
  migrate?: (configuration: Record<string, Schema.Json>, version: number) => Record<string, Schema.Json>
}

/** A single writer for installation configuration; credentials never leave redacted projections. */
export class Configuration {
  private queue = Promise.resolve()
  private document: typeof Document.Type = { version: 1, extensions: {} }

  constructor(private readonly file: string) {}

  async restore() {
    const source = await readFile(this.file, "utf8").catch((error) => {
      if (missing(error)) return undefined
      throw error
    })

    if (source) this.document = Schema.decodeUnknownSync(Schema.fromJsonString(Document))(source)
  }

  selection(descriptor: ExtensionDescriptor) {
    const saved = this.document.extensions[descriptor.id]
    const overrides = saved?.configuration ?? {}
    const version = saved?.configuration_version ?? descriptor.configuration_version

    if (version > descriptor.configuration_version) throw new Error("Configuration is newer than this extension.")
    if (version !== descriptor.configuration_version && !descriptor.migrate)
      throw new Error("This extension cannot migrate its saved configuration.")

    const migrated = version === descriptor.configuration_version ? overrides : descriptor.migrate!(overrides, version)
    const configuration = { ...descriptor.defaults, ...migrated }
    const schema = configurationSchema(descriptor)

    Schema.decodeUnknownSync(schema)(configuration)

    return { enabled: saved?.enabled ?? descriptor.default_enabled, configuration }
  }

  change(descriptor: ExtensionDescriptor, input: Nexus.ExtensionChange) {
    const pending = this.queue.then(async () => {
      const current = this.selection(descriptor)
      const saved = this.document.extensions[descriptor.id]
      const version = saved?.configuration_version ?? descriptor.configuration_version
      const configuration = structuredClone(
        version === descriptor.configuration_version
          ? (saved?.configuration ?? {})
          : descriptor.migrate!(saved?.configuration ?? {}, version),
      )

      for (const operation of input.operations ?? []) edit(configuration, operation)

      Schema.decodeUnknownSync(configurationSchema(descriptor))({ ...descriptor.defaults, ...configuration })

      const next = {
        version: 1 as const,
        extensions: {
          ...this.document.extensions,
          [descriptor.id]: {
            enabled: input.enabled ?? current.enabled,
            configuration_version: descriptor.configuration_version,
            configuration,
          },
        },
      }

      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await atomic(this.file, next)
      this.document = next
    })

    this.queue = pending.catch(() => {})

    return pending
  }
}

function configurationSchema(descriptor: ExtensionDescriptor) {
  return Schema.make<Schema.Codec<unknown>>(
    SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(descriptor.configuration_schema)).ast,
  )
}

function edit(configuration: Record<string, Schema.Json>, operation: Nexus.FieldOperation) {
  const parent = operation.path.slice(0, -1).reduce((value, key) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid configuration path.")
    const next = value[key]

    if (next === undefined) {
      const child: Record<string, Schema.Json> = {}
      value[key] = child
      return child
    }

    if (next === null || typeof next !== "object" || Array.isArray(next))
      throw new Error("Configuration paths traverse objects; replace arrays as a field.")

    return next as Record<string, Schema.Json>
  }, configuration)
  const key = operation.path.at(-1)!

  if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid configuration path.")
  if (operation.op === "unset") {
    delete parent[key]
    return
  }

  parent[key] = structuredClone(operation.value)
}

export function redact(
  configuration: Record<string, Schema.Json>,
  schema: JsonSchema.JsonSchema,
): Record<string, Schema.Json> {
  if (typeof schema === "boolean") return configuration
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema.JsonSchema>

  return Object.fromEntries(
    Object.entries(configuration).map(([key, value]) => {
      const field = properties[key] ?? (schema.additionalProperties as JsonSchema.JsonSchema | undefined)

      if (!field || typeof field === "boolean") return [key, value]
      if (field.writeOnly) return [key, value === null || value === "" ? null : "[saved]"]
      if (value && typeof value === "object" && !Array.isArray(value))
        return [key, redact(value as Record<string, Schema.Json>, field)]
      if (Array.isArray(value) && field.items && !Array.isArray(field.items))
        return [
          key,
          value.map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? redact(item as Record<string, Schema.Json>, field.items as JsonSchema.JsonSchema)
              : item,
          ),
        ]

      return [key, value]
    }),
  )
}
