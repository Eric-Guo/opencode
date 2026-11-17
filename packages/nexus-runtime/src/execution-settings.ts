import { Schema } from "effect"
import type { Nexus } from "@opencode/schema/nexus"
import type { ExtensionModule } from "./extension-manager"

const Coding = Schema.Struct({ bash_timeout_seconds: Schema.Number })
const Checkpoints = Schema.Struct({
  retention_days: Schema.Number,
  max_file_bytes: Schema.Number,
  max_tree_bytes: Schema.Number,
  capture_timeout_seconds: Schema.Number,
})

export function executionExtensions(): ExtensionModule[] {
  return [
    {
      id: "nexus.coding",
      name: "Coding",
      description: "Read, edit and search workspace files, and run shell commands.",
      configuration_schema: {
        type: "object",
        properties: { bash_timeout_seconds: { type: "integer", minimum: 1, maximum: 540, default: 120 } },
        additionalProperties: false,
      },
    },
    {
      id: "nexus.checkpoints",
      name: "Checkpoints",
      description: "Capture workspace changes and restore earlier file states.",
      configuration_schema: {
        type: "object",
        properties: {
          retention_days: { type: "integer", minimum: 1, default: 7 },
          max_file_bytes: { type: "integer", minimum: 1, default: 2097152 },
          max_tree_bytes: { type: "integer", minimum: 1, default: 268435456 },
          capture_timeout_seconds: { type: "integer", minimum: 1, default: 30 },
        },
        additionalProperties: false,
      },
    },
    {
      id: "nexus.lifecycle-hooks",
      name: "Lifecycle hooks",
      description: "Run declared tools at execution and compaction boundaries.",
      configuration_schema: {
        type: "object",
        properties: Object.fromEntries(
          ["turn_start", "pre_compact", "post_compact", "stop"].map((name) => [
            name,
            {
              type: "object",
              properties: {
                tool: { type: "string", minLength: 1 },
                timeout_ms: { type: "integer", minimum: 1, maximum: 300000 },
                ...(name === "stop" ? { max_continuations: { type: "integer", minimum: 0, maximum: 20 } } : {}),
              },
              required: ["tool", "timeout_ms", ...(name === "stop" ? ["max_continuations"] : [])],
              additionalProperties: false,
              "x-nexus-atomic": true,
            },
          ]),
        ),
        additionalProperties: false,
      },
    },
  ].map((descriptor) => ({
    descriptor: { ...descriptor, default_enabled: true, configuration_version: 1, defaults: {} },
    register() {},
  }))
}

/** Read normalized installation settings once when capturing execution policy. */
export function executionConfiguration(extensions: readonly Nexus.Extension[]) {
  const coding = extensions.find((row) => row.id === "nexus.coding" && row.active)
  const checkpoints = extensions.find((row) => row.id === "nexus.checkpoints" && row.active)
  const hooks = extensions.find((row) => row.id === "nexus.lifecycle-hooks" && row.active)
  const checkpoint = checkpoints && Schema.decodeUnknownSync(Checkpoints)(checkpoints.configuration)

  return {
    coding: !!coding,
    bashTimeoutSeconds: coding ? Schema.decodeUnknownSync(Coding)(coding.configuration).bash_timeout_seconds : 120,
    checkpoints: checkpoint
      ? {
          retentionDays: checkpoint.retention_days,
          maxFileBytes: checkpoint.max_file_bytes,
          maxTreeBytes: checkpoint.max_tree_bytes,
          captureTimeoutMs: checkpoint.capture_timeout_seconds * 1000,
        }
      : undefined,
    lifecycle_hooks: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
      hooks?.configuration ?? {},
    ),
  }
}
