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

test("open configuration records retain inherited fields through sparse edits", () => {
  const schema = {
    type: "object",
    additionalProperties: { type: "object", additionalProperties: true },
  }
  expect(
    configurationFields(
      schema,
      { first: { enabled: false } },
      {
        first: { enabled: true, transport: "http", tools: ["*"] },
        second: { transport: "stdio" },
      },
    ),
  ).toEqual({
    value: { first: { enabled: false, transport: "http", tools: ["*"] }, second: { transport: "stdio" } },
    overrides: { first: { enabled: false } },
    diagnostics: [],
  })
})

test("execution settings persist sparse edits, reject invalid hooks atomically and restore defaults", async () => {
  const { Configuration } = await import("../src/configuration")
  const { executionExtensions } = await import("../src/execution-settings")
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "nexus-execution-settings-"))
  const configuration = new Configuration(join(directory, "configuration.json"))
  const descriptors = executionExtensions().map((module) => module.descriptor)
  const coding = descriptors.find((row) => row.id === "nexus.coding")!
  const checkpoints = descriptors.find((row) => row.id === "nexus.checkpoints")!
  const hooks = descriptors.find((row) => row.id === "nexus.lifecycle-hooks")!
  try {
    expect(configuration.selection(coding).configuration).toEqual({ bash_timeout_seconds: 120 })
    await configuration.change(coding, {
      id: coding.id,
      operations: [{ op: "set", path: ["bash_timeout_seconds"], value: 42 }],
    })
    await configuration.change(checkpoints, {
      id: checkpoints.id,
      enabled: false,
      operations: [{ op: "set", path: ["max_tree_bytes"], value: 512 }],
    })
    const value = { tool: "verify", timeout_ms: 30000, max_continuations: 2 }
    await configuration.change(hooks, {
      id: hooks.id,
      operations: [{ op: "set", path: ["stop"], value }],
    })
    for (const invalid of [{ ...value, timeout_ms: 300001 }, { ...value, max_continuations: 21 }, { tool: "verify" }])
      await expect(
        configuration.change(hooks, {
          id: hooks.id,
          operations: [{ op: "set", path: ["stop"], value: invalid }],
        }),
      ).rejects.toThrow("Invalid configuration edit")
    const restored = new Configuration(join(directory, "configuration.json"))
    await restored.restore()
    expect(restored.selection(coding).configuration).toEqual({ bash_timeout_seconds: 42 })
    expect(restored.selection(checkpoints)).toMatchObject({ enabled: false, configuration: { max_tree_bytes: 512 } })
    expect(restored.selection(hooks).configuration).toEqual({ stop: value })
    await restored.change(coding, { id: coding.id, operations: [{ op: "unset", path: ["bash_timeout_seconds"] }] })
    expect(restored.selection(coding).configuration).toEqual({ bash_timeout_seconds: 120 })
    expect(configurationFields(coding.configuration_schema, { bash_timeout_seconds: 0 }).value).toEqual({
      bash_timeout_seconds: 120,
    })
    expect(
      configurationFields(hooks.configuration_schema, {
        stop: { tool: "verify" },
        turn_start: { tool: "verify", timeout_ms: 1 },
      }).value,
    ).toEqual({ turn_start: { tool: "verify", timeout_ms: 1 } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
