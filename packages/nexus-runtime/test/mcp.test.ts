import { expect, test } from "bun:test"
import { ToolLowering } from "@cybros/agent"
import { createHash } from "node:crypto"
import { mcpName, mcpSettings } from "../src/mcp-settings"
import { curateMcp, curateMcpDocuments, mcpAnnouncementBytes } from "../src/mcp-curation"
import { mcpResult } from "../src/mcp"
import { Mcp } from "@opencode/core/mcp/index"

test("MCP settings isolate faults, expand credentials once and default the transport role", () => {
  const settings = mcpSettings(
    {
      local: {
        transport: "stdio",
        command: "peer",
        tools: ["read"],
        env: { KEY: "literal-secret", EXPANDED: "${TOKEN}" },
      },
      remote: { transport: "http", url: "https://example.test/mcp", tools: ["*"], headers: { Cookie: "${TOKEN}" } },
      missing: { transport: "stdio", command: "peer", tools: ["*"], env: { KEY: "${UNSET}" } },
      insecure: {
        transport: "http",
        url: "http://example.test/mcp",
        tools: ["*"],
        headers: { Other: "private-value" },
      },
      parked: { transport: "stdio", command: "absent", tools: ["*"], enabled: false },
      uncurated: { transport: "stdio", command: "peer" },
      invalid: { transport: "stdio", command: "peer", tools: ["*"], effect_profiles: { read: { kind: "read_only" } } },
    },
    "/project",
    { TOKEN: "${NESTED_TOKEN}", NESTED_TOKEN: "must-not-expand" },
  )

  expect(settings.rows.map((row) => [row.key, row.role, row.timeout])).toEqual([
    ["local", "runner", 600000],
    ["remote", "agent", 60000],
    ["parked", "runner", 600000],
    ["context7", "agent", 60000],
  ])
  expect(settings.rows[0].config).toMatchObject({ environment: { EXPANDED: "${NESTED_TOKEN}" }, cwd: "/project" })
  expect(settings.rows[0].secrets).toEqual(["${NESTED_TOKEN}", "literal-secret"])
  expect(settings.faults.map((row) => row.key)).toEqual(["missing", "insecure", "uncurated", "invalid"])
  expect(JSON.stringify(settings.faults)).not.toContain("private-value")
  expect(() => mcpSettings({ "Bad Key": {} }, "/project")).toThrow("names")
  expect(() => mcpSettings({ valid: [] }, "/project")).toThrow()
  expect(mcpSettings(["existing"], "/project").rows[0]).toMatchObject({ server: "existing", transport: "opencode" })
  expect(mcpSettings(["existing"], "/project").rows[0].config).toBeUndefined()
  const enabled = mcpSettings({ docs: { transport: "http", url: "https://example.test", tools: ["*"] } }, "/project")
    .rows[0]
  const disabled = mcpSettings(
    { docs: { transport: "http", url: "https://example.test", tools: ["*"], enabled: false } },
    "/project",
  ).rows[0]
  expect(disabled.server).not.toBe(enabled.server)
  expect(disabled.credentialKey).toBe(enabled.server)
  expect(enabled.credentialKey).toBe(enabled.server)
})

test("MCP public naming preserves simple names and separates normalization collisions", () => {
  expect(mcpName("docs", "read")).toBe("mcp__docs__read")
  expect(mcpName("docs", "Read Notes", true)).toBe(
    "docs-read-notes-" + createHash("sha256").update("docs\0Read Notes").digest("hex").slice(0, 12),
  )
  expect(mcpName("docs", "a.b")).not.toBe(mcpName("docs", "a b"))
  expect(mcpName("docs", "x".repeat(100))).toHaveLength(64)
  expect(mcpName("docs", "x".repeat(100), true)).toHaveLength(64)
  expect(mcpName("docs", "read😀notes")).toBe("mcp__docs__read_notes_6c6a75c05cde")
  expect(mcpName("docs", "read😀notes", true)).toBe("docs-read-notes-6c6a75c05cde")
})

test("MCP curation treats stale explicit lists atomically and keeps verbatim descriptions and operator profiles", () => {
  const row = mcpSettings(
    {
      docs: {
        transport: "stdio",
        command: "peer",
        tools: ["*"],
        effect_profiles: {
          read: {
            kind: "read_only",
            destructive: false,
            effect_scope: "closed",
            idempotency: "intrinsic",
            reconciliation: "none",
          },
        },
      },
    },
    "/project",
  ).rows[0]
  const tools = [
    {
      name: "read",
      description: "  Precise\nserver instructions  ",
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", pattern: "^/" } },
        dependentRequired: { path: ["revision"] },
      },
    },
    { name: "blank", description: " ", inputSchema: { type: "object" as const } },
    {
      name: "broken",
      description: "Broken schema",
      inputSchema: { type: "object" as const, properties: { field: { type: "not-a-type" } } },
    },
  ]
  const result = curateMcp(row, tools)

  expect(result.fault).toBeNull()
  expect(result.tools).toHaveLength(1)
  expect(result.tools[0].definition).toMatchObject({
    description: tools[0].description,
    effect_profile: row.profiles.read,
    mcp: { server_key: "docs", tool_name: "read" },
    timeout_ms: 600000,
  })
  expect(result.skipped).toHaveLength(2)
  const definition = result.tools[0].definition
  const modelBytes = Buffer.byteLength(JSON.stringify(ToolLowering.functionEntry(definition)))
  const announcementBytes = Buffer.byteLength(JSON.stringify(definition))

  expect(result.tools[0].bytes).toBe(modelBytes)
  expect(result.bytes).toBe(modelBytes)
  expect(mcpAnnouncementBytes([definition, definition])).toBe(announcementBytes * 2 + 3)
  const multiple = curateMcp(row, [tools[0], { ...tools[0], name: "write" }])
  expect(multiple.bytes).toBe(
    Buffer.byteLength(JSON.stringify(ToolLowering.functionEntry(multiple.tools[1].definition))) + modelBytes,
  )
  expect(curateMcp(row, []).bytes).toBe(0)
  expect(curateMcp({ ...row, tools: ["missing"] }, tools).fault).toContain("missing")
  expect(curateMcp({ ...row, tools: ["read", "blank"] }, tools).tools).toEqual([])
  expect(curateMcp(row, [...tools, tools[0]]).fault).toContain("duplicate")
})

test("MCP documents exclude required arguments, binary resources and duplicate names", () => {
  const row = mcpSettings({ docs: { transport: "http", url: "https://example.test", tools: ["*"] } }, "/project")
    .rows[0]
  const server = Mcp.ServerName.make(row.server)
  const result = curateMcpDocuments(
    row,
    [
      { server, name: "read", description: "Read instructions" },
      { server, name: "required", description: "Needs input", arguments: [{ name: "name", required: true }] },
    ],
    [
      { server, name: "read", description: "Collision", uri: "test://read" },
      { server, name: "binary", description: "Binary", uri: "test://binary", mimeType: "application/octet-stream" },
      { server, name: "unknown", description: "Read decides format", uri: "test://unknown" },
    ],
  )

  expect(result.documents.map((document) => document.name)).toEqual(["docs-read", "docs-unknown"])
  expect(result.skipped).toHaveLength(3)
})

test("MCP result mapping redacts nested structured content and only publishes readable media", async () => {
  const row = mcpSettings(
    {
      docs: {
        transport: "http",
        url: "https://example.test",
        tools: ["*"],
        headers: { Authorization: "secret-value" },
      },
    },
    "/project",
  ).rows[0]
  const uploads: Blob[] = []
  const result = await mcpResult(
    {
      isError: false,
      structured: { nested: ["secret-value"] },
      content: [
        { type: "text", text: "Credential secret-value" },
        { type: "media", mimeType: "audio/wav", data: "YQ==" },
        { type: "media", mimeType: "image/png", data: "YQ==" },
      ],
    },
    row,
    {
      workspace: "w",
      conversation: "c",
      run: "r",
      task: "t",
      directory: "/project",
      signal: new AbortController().signal,
      publish: async (blob, name) => {
        uploads.push(blob)
        return { type: "resource_link", uri: "nexus://image", name }
      },
    },
  )

  expect(JSON.stringify(result)).not.toContain("secret-value")
  expect(result.structured_content).toEqual({ nested: ["[redacted]"] })
  expect(result.content).toMatchObject([
    { type: "text", text: "Credential [redacted]" },
    { type: "text", text: "[audio/wav content discarded]" },
    { type: "resource_link" },
  ])
  expect(uploads).toHaveLength(1)
  expect(await uploads[0].text()).toBe("a")
})
