import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Schema, type JsonSchema } from "effect"
import { Ajv, type ValidateFunction } from "ajv"
import { Ajv2020 } from "ajv/dist/2020.js"
import type { Nexus } from "@opencode/schema/nexus"
import { atomic, missing } from "./storage"
import { configurationFields } from "./configuration-fields"

const Selection = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  configuration_version: Schema.optional(Schema.Int),
  configuration: Schema.Record(Schema.String, Schema.Json),
  source: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
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
    const resolved = configurationFields(descriptor.configuration_schema, migrated, descriptor.defaults)
    const configuration = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(resolved.value ?? {})

    return { enabled: saved?.enabled ?? descriptor.default_enabled, configuration }
  }

  diagnostics(descriptor: ExtensionDescriptor) {
    const saved = this.document.extensions[descriptor.id]
    const from = saved?.configuration_version ?? descriptor.configuration_version
    const raw =
      from === descriptor.configuration_version
        ? (saved?.configuration ?? {})
        : (descriptor.migrate?.(saved?.configuration ?? {}, from) ?? {})
    return configurationFields(descriptor.configuration_schema, raw, descriptor.defaults).diagnostics
  }

  saved(id: string) {
    return structuredClone(this.document.extensions[id])
  }

  sources() {
    return Object.entries(this.document.extensions).flatMap(([id, value]) =>
      value.source ? [{ id, source: structuredClone(value.source) }] : [],
    )
  }

  replace(
    descriptor: ExtensionDescriptor,
    selection: { enabled: boolean; configuration: Record<string, Schema.Json>; source?: Record<string, Schema.Json> },
  ) {
    validateConfiguration(descriptor, selection.configuration)
    const pending = this.queue.then(async () => {
      const next = {
        version: 1 as const,
        extensions: {
          ...this.document.extensions,
          [descriptor.id]: { ...selection, configuration_version: descriptor.configuration_version },
        },
      }

      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await atomic(this.file, next)
      this.document = next
    })

    this.queue = pending.catch(() => {})
    return pending
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

      for (const operation of input.operations ?? []) edit(configuration, operation, descriptor.configuration_schema)

      const resolved = configurationFields(descriptor.configuration_schema, configuration, descriptor.defaults)
      const problem = resolved.diagnostics.find(
        (diagnostic) =>
          diagnostic.reason !== "required" &&
          (input.operations ?? []).some((operation) => {
            const length = Math.min(operation.path.length, diagnostic.path.length)
            return operation.path.slice(0, length).every((key, index) => diagnostic.path[index] === key)
          }),
      )
      if (problem)
        throw new Error("Invalid configuration edit at " + JSON.stringify(problem.path) + ": " + problem.reason)

      const next = {
        version: 1 as const,
        extensions: {
          ...this.document.extensions,
          [descriptor.id]: {
            ...(saved?.source ? { source: saved.source } : {}),
            enabled: input.enabled ?? current.enabled,
            configuration_version: descriptor.configuration_version,
            configuration: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
              resolved.overrides ?? {},
            ),
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

const validators = new WeakMap<object, ValidateFunction>()

export function validateConfiguration(descriptor: ExtensionDescriptor, configuration: Record<string, Schema.Json>) {
  const schema = descriptor.configuration_schema
  const validator =
    validators.get(schema) ??
    (/draft-0[467]/.test(String(schema.$schema))
      ? new Ajv({ strict: false, validateFormats: false })
      : new Ajv2020({ strict: false, validateFormats: false })
    ).compile(schema)
  validators.set(schema, validator)
  if (!validator(configuration))
    throw new Error(
      "Invalid extension configuration: " +
        (validator.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; "),
    )
}

function edit(
  configuration: Record<string, Schema.Json>,
  operation: Nexus.FieldOperation,
  schema: JsonSchema.JsonSchema,
) {
  operation.path.reduce((node, key) => {
    const types = typeof node.type === "string" ? [node.type] : Array.isArray(node.type) ? node.type : []
    if (types.length && !types.includes("object"))
      throw new Error("Configuration arrays and scalar fields must be edited as a whole.")
    const properties = (node.properties ?? {}) as Record<string, JsonSchema.JsonSchema>
    const child = Object.hasOwn(properties, key) ? properties[key] : node.additionalProperties
    if (!child) throw new Error("Unknown configuration field: " + key)
    return typeof child === "object" ? (child as JsonSchema.JsonSchema) : {}
  }, schema)
  const parent = operation.path.slice(0, -1).reduce((value, key) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid configuration path.")
    const next = value[key]

    if (!next || typeof next !== "object" || Array.isArray(next)) {
      const child: Record<string, Schema.Json> = {}
      value[key] = child
      return child
    }

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
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema.JsonSchema>
  return Object.fromEntries(
    Object.entries(configuration).map(([key, value]) => [
      key,
      redactValue(value, properties[key] ?? schema.additionalProperties),
    ]),
  )
}

function redactValue(value: Schema.Json, schema: unknown): Schema.Json {
  if (!schema || typeof schema !== "object") return value
  const field = schema as JsonSchema.JsonSchema
  if (field.writeOnly) return value === null || value === "" ? null : "[saved]"
  if (Array.isArray(value)) return value.map((item) => redactValue(item, field.items))
  if (value && typeof value === "object") return redact(value as Record<string, Schema.Json>, field)
  return value
}

/** Secret annotations are credentials too; never publish them as form defaults or enum choices. */
export function publicConfigurationSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const visit = (node: JsonSchema.JsonSchema, inherited = false): JsonSchema.JsonSchema => {
    const hidden = inherited || node.writeOnly === true
    const result = { ...node }
    if (hidden) {
      delete result.default
      delete result.examples
      delete result.enum
      delete result.const
    }
    if (node.properties)
      result.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, child]) => [key, visit(child as JsonSchema.JsonSchema, hidden)]),
      )
    if (node.additionalProperties && typeof node.additionalProperties === "object")
      result.additionalProperties = visit(node.additionalProperties as JsonSchema.JsonSchema, hidden)
    if (node.items && !Array.isArray(node.items)) result.items = visit(node.items as JsonSchema.JsonSchema, hidden)
    if (!hidden) {
      for (const key of ["default", "const"] as const) {
        const value = result[key]
        if (value !== undefined) result[key] = redactValue(value as Schema.Json, node)
      }
      for (const key of ["examples", "enum"] as const) {
        if (Array.isArray(result[key]))
          result[key] = result[key].map((value) => redactValue(value as Schema.Json, node))
      }
    }
    return result
  }
  return visit(schema)
}
