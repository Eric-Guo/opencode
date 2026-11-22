import { createHash } from "node:crypto"
import { JsonSchema, Schema } from "effect"
import { FileAccess } from "@opencode/core/file-access"
import type { Mcp } from "@opencode/schema/mcp"
import { integrationSecrets, integrationValues } from "./integration-secrets"

const Timeout = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(604800000))
const Profile = Schema.Struct({
  kind: Schema.Literals(["pure", "read_only", "write"]),
  destructive: Schema.Boolean,
  effect_scope: Schema.Literals(["closed", "open"]),
  idempotency: Schema.Literals(["intrinsic", "keyed", "none"]),
  reconciliation: Schema.Literals(["none", "lookup"]),
})
const Row = Schema.Struct({
  transport: Schema.Literals(["stdio", "http"]),
  command: Schema.optional(Schema.NonEmptyString),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optional(Schema.NonEmptyString),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  tools: Schema.NonEmptyArray(Schema.NonEmptyString),
  timeout_ms: Schema.optional(Timeout),
  startup_timeout_ms: Schema.optional(Timeout),
  serves: Schema.optional(Schema.Literals(["agent", "runner"])),
  enabled: Schema.optional(Schema.Boolean),
  effect_profiles: Schema.optional(Schema.Record(Schema.String, Profile)),
  oauth: Schema.optional(
    Schema.Struct({
      client_id: Schema.optional(Schema.NonEmptyString),
      callback_port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    }),
  ),
})

export type McpRow = {
  key: string
  server: string
  config?: Mcp.ServerConfig
  transport: "stdio" | "http" | "opencode"
  role: "agent" | "runner"
  enabled: boolean
  tools: readonly string[]
  timeout: number
  profiles: Readonly<Record<string, typeof Profile.Type>>
  secrets: string[]
  oauth?: boolean
  credentialKey?: string
}

export const mcpConfiguration = {
  type: "object",
  properties: {
    servers: {
      type: ["object", "array"],
      items: { type: "string" },
      uniqueItems: true,
      additionalProperties: {
        type: "object",
        additionalProperties: true,
        properties: {
          env: { type: "object", additionalProperties: { type: "string" }, writeOnly: true },
          headers: { type: "object", additionalProperties: { type: "string" }, writeOnly: true },
        },
      },
    },
  },
  required: ["servers"],
  additionalProperties: false,
} satisfies JsonSchema.JsonSchema

export const mcpDefaults = {
  context7: { transport: "http", url: "https://mcp.context7.com/mcp", tools: ["*"], enabled: false, serves: "agent" },
}

export function mcpSettings(
  input: unknown,
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
  literal = false,
) {
  const rows: McpRow[] = []
  const probes = new Map<string, McpRow>()
  const faults: { key: string; issue: string }[] = []

  if (Array.isArray(input)) {
    for (const key of Schema.decodeUnknownSync(Schema.Array(Schema.NonEmptyString))(input))
      rows.push({
        key,
        server: key,
        transport: "opencode",
        role: "runner",
        enabled: true,
        tools: ["*"],
        timeout: 600000,
        profiles: {},
        secrets: [],
      })

    return { rows, faults, probes }
  }

  const overrides = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))(
    input,
  )
  const merged = literal ? overrides : { ...overrides, context7: { ...mcpDefaults.context7, ...overrides.context7 } }
  const table = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))(
    merged,
  )

  for (const [key, value] of Object.entries(table)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || key.length > 32)
      throw new Error("MCP server names must use lowercase letters, digits and single hyphens, up to 32 characters.")

    const parsed = Schema.decodeUnknownOption(Row, { onExcessProperty: "error" })({ tools: ["*"], ...value })

    if (parsed._tag === "None") {
      faults.push({
        key,
        issue:
          "Invalid MCP row: transport and a nonempty tools allowlist are required; check transport options, timeouts and effect_profiles.",
      })
      continue
    }

    const row = parsed.value
    const env = integrationValues(row.env ?? {}, environment, { literal })
    const headerValues = integrationValues(row.headers ?? {}, environment, { literal, headers: true })
    const headers = headerValues.resolved
    const missing = new Set([...env.missing, ...headerValues.missing])

    if (missing.size) {
      faults.push({ key, issue: "Unset environment variables: " + [...missing].join(", ") })
      continue
    }
    if (row.tools.includes("*") && row.tools.length !== 1) {
      faults.push({ key, issue: 'The wildcard tools allowlist must be exactly ["*"].' })
      continue
    }

    const timeout = row.timeout_ms ?? (row.transport === "http" ? 60000 : 600000)
    const common = {
      disabled: row.enabled === false,
      codemode: false,
      timeout: {
        startup: row.startup_timeout_ms ?? 30000,
        catalog: row.startup_timeout_ms ?? 30000,
        execution: timeout,
      },
    }
    const url = row.url ? URL.parse(row.url) : null
    const secure =
      !!url &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))))

    if (row.transport === "stdio" && (!row.command || row.oauth)) {
      faults.push({ key, issue: "A stdio server requires command and cannot configure OAuth." })
      continue
    }
    if (row.transport === "http" && (!url || !["http:", "https:"].includes(url.protocol))) {
      faults.push({ key, issue: "An HTTP server requires an http:// or https:// URL." })
      continue
    }
    if (row.transport === "http" && !secure && (Object.keys(headers).length || row.oauth)) {
      faults.push({ key, issue: "Credentials require HTTPS or a loopback HTTP server." })
      continue
    }
    if (row.oauth && Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
      faults.push({ key, issue: "OAuth cannot be combined with an Authorization header." })
      continue
    }

    const config: Mcp.ServerConfig =
      row.transport === "stdio"
        ? {
            ...common,
            type: "local",
            command: [row.command!, ...(row.args ?? [])],
            cwd: FileAccess.resolvePath(directory, row.cwd || "."),
            environment: env.resolved,
          }
        : {
            ...common,
            type: "remote",
            url: row.url!,
            headers,
            oauth:
              secure && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
                ? row.oauth
                : false,
          }

    const candidate: McpRow = {
      key,
      // Scoped transforms can coexist during a staged settings replacement. Identical rows reuse the connection.
      server: "nexus-" + key + "-" + createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12),
      config,
      // Keep the shipped enabled-row credential key when a disabled mount is configured or probed.
      credentialKey:
        "nexus-" +
        key +
        "-" +
        createHash("sha256")
          .update(JSON.stringify({ ...config, disabled: false }))
          .digest("hex")
          .slice(0, 12),
      transport: row.transport,
      role: row.serves ?? (row.transport === "http" ? "agent" : "runner"),
      enabled: row.enabled ?? true,
      tools: row.tools,
      timeout,
      profiles: row.effect_profiles ?? {},
      secrets: integrationSecrets([...env.secrets, ...headerValues.secrets]),
    }

    if (value.tools === undefined) {
      faults.push({ key, issue: "Choose a tools allowlist. Probe this server to preview its catalog." })
      probes.set(key, candidate)
      continue
    }

    rows.push(candidate)
  }

  return { rows, faults, probes }
}

export function mcpName(server: string, raw: string, document = false) {
  const plain = document ? server + "-" + raw : "mcp__" + server + "__" + raw
  const normalized = document
    ? plain
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    : plain.replace(/[^a-zA-Z0-9_-]/gu, "_")

  if (plain === normalized && plain.length <= 64) return plain

  const digest = createHash("sha256")
    .update(server + "\0" + raw)
    .digest("hex")
    .slice(0, 12)

  return (
    (document ? normalized.slice(0, 51).replace(/-+$/, "") : normalized.slice(0, 51)) + (document ? "-" : "_") + digest
  )
}

export function mcpRedact(value: string, row: Pick<McpRow, "secrets">) {
  return row.secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
}
