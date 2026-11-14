import { expect, test } from "bun:test"
import { publicConfigurationSchema, redact, validateConfiguration } from "../src/configuration"
import { configurationFields } from "../src/configuration-fields"

const descriptor = {
  id: "config",
  name: "Config",
  description: "",
  default_enabled: false,
  configuration_version: 1,
  defaults: {},
  configuration_schema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["token", "command"] },
      token: {
        type: "string",
        writeOnly: true,
        default: "private-default",
        enum: ["private-enum"],
        examples: ["private-example"],
      },
      keys: { type: "array", items: { type: "string", writeOnly: true }, default: ["private-item"] },
      command: { type: "string" },
    },
    default: { token: "private-parent", keys: ["private-array"] },
    required: ["mode"],
    additionalProperties: false,
    if: { properties: { mode: { const: "token" } } },
    then: { required: ["token"] },
    else: { required: ["command"] },
  },
}

test("configuration validates conditional constraints and redacts secrets in values and schema annotations", () => {
  validateConfiguration(descriptor, { mode: "command", command: "worker" })
  expect(() => validateConfiguration(descriptor, { mode: "token" })).toThrow("token")
  expect(() => validateConfiguration(descriptor, { mode: "command", command: "worker", extra: true })).toThrow(
    "additional",
  )
  expect(redact({ mode: "token", token: "private", keys: ["private"] }, descriptor.configuration_schema)).toEqual({
    mode: "token",
    token: "[saved]",
    keys: ["[saved]"],
  })
  expect(JSON.stringify(publicConfigurationSchema(descriptor.configuration_schema))).not.toContain("private")
})

test("startup quarantines invalid fields while retaining siblings, sparse intent and atomic defaults", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      count: { type: "integer", minimum: 1, default: 7 },
      nested: {
        type: "object",
        properties: { enabled: { type: "boolean", default: true }, label: { type: "string" } },
        additionalProperties: false,
      },
      list: { type: "array", items: { type: "string" }, default: ["fallback"] },
      group: {
        type: "object",
        "x-rho-atomic": true,
        properties: { low: { type: "integer" }, high: { type: "integer" } },
        required: ["low", "high"],
        default: { low: 1, high: 2 },
      },
      required: { type: "string" },
    },
    required: ["required"],
  }
  const result = configurationFields(schema, {
    count: "invalid",
    nested: { enabled: false, label: "kept" },
    list: ["valid", 3],
    group: { low: 1 },
    unknown: "private-invalid-value",
  })
  expect(result.value).toEqual({
    count: 7,
    nested: { enabled: false, label: "kept" },
    list: ["fallback"],
    group: { low: 1, high: 2 },
  })
  expect(result.overrides).toEqual({ nested: { enabled: false, label: "kept" } })
  expect(result.diagnostics).toEqual([
    { path: ["count"], reason: "type", fallback: "default" },
    { path: ["list"], reason: "type", fallback: "default" },
    { path: ["group"], reason: "group_required", fallback: "default" },
    { path: ["unknown"], reason: "unknown_field", fallback: "unset" },
    { path: ["required"], reason: "required", fallback: "unset" },
  ])
  expect(JSON.stringify(result.diagnostics)).not.toContain("private-invalid-value")
  expect(configurationFields(schema, {}, { count: 9, nested: { label: "installed" } }).value).toEqual({
    count: 9,
    nested: { enabled: true, label: "installed" },
    list: ["fallback"],
    group: { low: 1, high: 2 },
  })
})
