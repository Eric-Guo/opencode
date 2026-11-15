import { Ajv2020 } from "ajv/dist/2020.js"
import type { ValidateFunction } from "ajv"
import type { JsonSchema, Schema } from "effect"

export type ConfigurationDiagnostic = { path: string[]; reason: string; fallback: "default" | "unset" }
type Resolved = { value?: Schema.Json; overrides?: Schema.Json; diagnostics: ConfigurationDiagnostic[] }
const validators = new WeakMap<object, ValidateFunction>()
type Field = JsonSchema.JsonSchema & {
  type?: string | readonly string[]
  properties?: Record<string, Field>
  additionalProperties?: boolean | Field
  required?: readonly string[]
  items?: Field | readonly Field[]
  default?: Schema.Json
}

/** Sparse saved intent is independent of defaults and of invalid values quarantined during startup. */
export function configurationFields(
  source: JsonSchema.JsonSchema,
  input: Schema.Json | undefined,
  defaults?: Schema.Json,
  path: string[] = [],
): Resolved {
  validator(source)
  const schema = source as Field
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema.JsonSchema>
  const kind = Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type
  const fallback = (reason?: string): Resolved => {
    const selected = defaults === undefined ? (schema.default as Schema.Json | undefined) : defaults
    const diagnostics: ConfigurationDiagnostic[] = reason
      ? [{ path, reason, fallback: selected === undefined ? "unset" : "default" }]
      : []
    if (selected !== undefined) {
      const validate = validator(schema)
      validate(selected)
      if (validate.errors?.some((error) => defaults === undefined || error.keyword !== "required"))
        throw new Error("Invalid configuration default at " + JSON.stringify(path))
      const value =
        selected && typeof selected === "object"
          ? configurationFields(schema, selected, undefined, path).value
          : selected
      return { value: structuredClone(value), diagnostics }
    }
    if (kind !== "object") return { diagnostics }
    const value = Object.fromEntries(
      Object.entries(properties).flatMap(([key, child]) => {
        const answer = configurationFields(child, undefined, undefined, [...path, key])
        return answer.value === undefined ? [] : [[key, answer.value]]
      }),
    )
    return Object.keys(value).length ? { value, diagnostics } : { diagnostics }
  }
  if (input === undefined) return fallback()
  const types = typeof schema.type === "string" ? [schema.type] : schema.type
  const type = input === null ? "null" : Array.isArray(input) ? "array" : typeof input
  if (
    types?.length &&
    !types.includes(type) &&
    !(type === "number" && Number.isInteger(input) && types.includes("integer"))
  )
    return fallback("type")
  if (input === null)
    return valid(schema, input) ? { value: null, overrides: null, diagnostics: [] } : fallback(reason(schema, input))
  if (kind === "object" && typeof input === "object" && !Array.isArray(input)) {
    if ((schema["x-rho-atomic"] || schema["x-nexus-atomic"]) && !valid(schema, input))
      return fallback("group_" + reason(schema, input))
    const inherited = (defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}) as Record<
      string,
      Schema.Json
    >
    const record = input as Record<string, Schema.Json>
    const value: Record<string, Schema.Json> = {}
    const overrides: Record<string, Schema.Json> = {}
    const diagnostics: ConfigurationDiagnostic[] = []
    for (const key of new Set([...Object.keys(properties), ...Object.keys(input), ...Object.keys(inherited)])) {
      const child = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties
      if (child === true) {
        if (inherited[key] !== undefined) value[key] = inherited[key]
        if (record[key] !== undefined) value[key] = overrides[key] = record[key]
        continue
      }
      if (!child || typeof child !== "object") {
        if (record[key] !== undefined)
          diagnostics.push({ path: [...path, key], reason: "unknown_field", fallback: "unset" })
        continue
      }
      const answer = configurationFields(child as JsonSchema.JsonSchema, record[key], inherited[key], [...path, key])
      if (answer.value !== undefined) value[key] = answer.value
      if (answer.overrides !== undefined) overrides[key] = answer.overrides
      diagnostics.push(...answer.diagnostics)
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) diagnostics.push({ path: [...path, key], reason: "required", fallback: "unset" })
    }
    const validate = validator(schema)
    validate(value)
    const problem = validate.errors?.find((error) => error.keyword !== "required")
    return problem ? fallback(problem.keyword) : { value, overrides, diagnostics }
  }
  if (kind === "array" && Array.isArray(input) && schema.items && !Array.isArray(schema.items)) {
    const answers = input.map((item, index) =>
      configurationFields(schema.items as JsonSchema.JsonSchema, item, undefined, [...path, String(index)]),
    )
    const diagnostics = answers.flatMap((answer) => answer.diagnostics)
    const invalid = diagnostics.find((entry) => entry.reason !== "unknown_field")
    if (invalid || answers.some((answer) => answer.value === undefined)) return fallback(invalid?.reason ?? "items")
    const value = answers.map((answer) => answer.value!)
    return valid(schema, value)
      ? { value, overrides: answers.map((answer) => answer.overrides ?? null), diagnostics }
      : fallback(reason(schema, value))
  }
  return valid(schema, input) ? { value: input, overrides: input, diagnostics: [] } : fallback(reason(schema, input))
}

function validator(schema: JsonSchema.JsonSchema) {
  const found = validators.get(schema)
  if (found) return found
  const compiled = new Ajv2020({ strict: false, validateFormats: false, allErrors: true }).compile(schema)
  validators.set(schema, compiled)
  return compiled
}

function valid(schema: JsonSchema.JsonSchema, input: Schema.Json) {
  return validator(schema)(input)
}

function reason(schema: JsonSchema.JsonSchema, input: Schema.Json) {
  const validate = validator(schema)
  validate(input)
  return validate.errors?.[0]?.keyword ?? "invalid"
}
