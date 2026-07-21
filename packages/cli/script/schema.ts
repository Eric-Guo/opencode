#!/usr/bin/env bun

import { Config } from "@opencode-ai/schema/config"
import { Schema } from "effect"
import { format } from "prettier"
import { Info, SchemaURL } from "../src/config/schema"

type JsonSchema = Record<string, unknown>
const MODEL_REF = "https://models.dev/model-schema.json#/$defs/Model"

const target = process.argv[2]
if (!target) throw new Error("A schema output path is required")

const tuiTarget = process.argv[3]
if (tuiTarget && tuiTarget !== "--check") {
  const tui = await import("@opencode-ai/tui/config")
  await Bun.write(target, JSON.stringify(generate(Config.Info), null, 2))
  await Bun.write(tuiTarget, JSON.stringify(generate(tui.Config.Info), null, 2))
  process.exit(0)
}

const document = Schema.toJsonSchemaDocument(Info)
const content = await format(
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SchemaURL,
    ...document.schema,
    ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
  }),
  { parser: "json", printWidth: 120 },
)

if (process.argv.includes("--check")) {
  if ((await Bun.file(target).text()) !== content) {
    console.error("Generated CLI config schema is stale. Run `bun run generate` from packages/www.")
    process.exit(1)
  }
  process.exit(0)
}

await Bun.write(target, content)

function generate(schema: Schema.Top) {
  const document = Schema.toJsonSchemaDocument(schema)
  const normalized = normalize({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  })
  if (!isRecord(normalized)) throw new Error("schema generator produced a non-object schema")
  const restored = restoreModelRefs(normalized)
  if (!isRecord(restored)) throw new Error("schema generator produced a non-object schema")
  restored.allowComments = true
  restored.allowTrailingCommas = true
  return restored
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value
  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (anyOf.length !== schema.anyOf.length) {
      const { anyOf: _, ...rest } = schema
      if (anyOf.length === 1 && isRecord(anyOf[0])) return normalize({ ...anyOf[0], ...rest })
      return { ...rest, anyOf }
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && isRecord(schema.allOf[0])) {
    const { allOf: _, ...rest } = schema
    return normalize({ ...schema.allOf[0], ...rest })
  }
  if (schema.type === "integer" && schema.maximum === undefined) return { ...schema, maximum: Number.MAX_SAFE_INTEGER }
  return schema
}

function restoreModelRefs(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => restoreModelRefs(item))
  if (!isRecord(value)) return value
  const schema = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, restoreModelRefs(item, name)]))
  if (key === "model" && schema.type === "string") return { ...schema, $ref: MODEL_REF }
  return schema
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
