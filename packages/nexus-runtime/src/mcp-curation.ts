import { Schema } from "effect"
import { ToolLowering, type AnnouncedTool } from "@cybros/agent"
import { compileToolSchema } from "./tool-schema"
import type { Mcp } from "@opencode/core/mcp/index"
import { openWrite } from "./extensions"
import { mcpName, type McpRow } from "./mcp-settings"

export function curateMcp(row: McpRow, listed: readonly Mcp.AdvertisedTool[]) {
  const tools: { raw: string; definition: AnnouncedTool; bytes: number }[] = []
  const skipped: { name: string; reason: string }[] = []
  const names = listed.map((tool) => tool.name)
  const missing = row.tools[0] === "*" ? [] : row.tools.filter((name) => !names.includes(name))

  if (new Set(names).size !== names.length)
    return { tools, skipped, fault: "tools/list contains duplicate names", bytes: 0 }
  if (missing.length)
    return { tools, skipped, fault: "Allowlisted tools were not listed: " + missing.join(", "), bytes: 0 }

  for (const tool of listed) {
    if (row.tools[0] !== "*" && !row.tools.includes(tool.name)) {
      skipped.push({ name: tool.name, reason: "Not in tools allowlist" })
      continue
    }
    if (!tool.description?.trim()) {
      if (row.tools[0] !== "*") return { tools: [], skipped: [], fault: tool.name + " has no description", bytes: 0 }

      skipped.push({ name: tool.name, reason: "No description" })
      continue
    }

    const schema = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.MutableJson))(tool.inputSchema)

    if (schema._tag === "None" || !validMcpSchema(schema.value)) {
      skipped.push({ name: tool.name, reason: "Invalid object JSON Schema" })
      continue
    }

    const name = mcpName(row.key, tool.name)
    const definition: AnnouncedTool = {
      name,
      description: tool.description,
      input_schema: schema.value,
      effect_profile: row.profiles[tool.name] ?? openWrite,
      timeout_ms: row.timeout,
      mcp: { server_key: row.key, tool_name: tool.name },
    }

    tools.push({
      raw: tool.name,
      definition,
      bytes: Buffer.byteLength(JSON.stringify(ToolLowering.functionEntry(definition))),
    })
  }

  return { tools, skipped, fault: null, bytes: tools.reduce((total, tool) => total + tool.bytes, 0) }
}

export function mcpAnnouncementBytes(tools: readonly AnnouncedTool[]) {
  return Buffer.byteLength(JSON.stringify(tools))
}

function validMcpSchema(schema: Schema.JsonObject): schema is NonNullable<AnnouncedTool["input_schema"]> {
  if (schema.type !== "object") return false

  try {
    compileToolSchema(schema)
    return true
  } catch {
    return false
  }
}

export function curateMcpDocuments(
  row: McpRow,
  prompts: readonly Mcp.Prompt[],
  resources: Mcp.ResourceCatalog["resources"],
) {
  const documents: { name: string; raw: string; description: string; kind: "prompt" | "resource"; uri?: string }[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const listing of [
    ...prompts.map((value) => ({ ...value, kind: "prompt" as const })),
    ...resources.map((value) => ({ ...value, kind: "resource" as const })),
  ]) {
    const name = mcpName(row.key, listing.name, true)
    const reason = !listing.name
      ? "No name"
      : !listing.description?.trim()
        ? "No description"
        : Buffer.byteLength(listing.description) > 1024
          ? "Description exceeds 1024 bytes"
          : documents.some((document) => document.name === name)
            ? "Duplicate document name"
            : listing.kind === "prompt" && listing.arguments?.some((argument) => argument.required)
              ? "Prompt requires arguments"
              : listing.kind === "resource" && listing.mimeType && !mcpReadable(listing.mimeType)
                ? "Unsupported resource media type"
                : undefined

    if (reason) {
      skipped.push({ name, reason })
      continue
    }

    documents.push({
      name,
      raw: listing.name,
      description: listing.description!,
      kind: listing.kind,
      ...(listing.kind === "resource" ? { uri: listing.uri } : {}),
    })
  }

  return { documents, skipped }
}

export function mcpReadable(mime: string) {
  return (
    /^(?:text\/)|^application\/(?:[\w.-]+\+)?(?:json|xml|yaml|x-yaml|toml)$/i.test(mime) ||
    mcpCaptureExtensions.has(mime)
  )
}

export const mcpCaptureExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["application/pdf", "pdf"],
])
