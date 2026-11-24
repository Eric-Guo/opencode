import { Effect, Exit, Schedule, Schema, Scope } from "effect"
import type { AnnouncedTool, JsonObject } from "@cybros/agent"
import { Integration } from "@opencode/core/integration"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Mcp } from "@opencode/core/mcp/index"
import type { ExtensionAPI } from "./extension-manager"
import type { RunnerContext } from "./extensions"
import type { HostTools } from "./host"
import { curateMcp, curateMcpDocuments, mcpAnnouncementBytes, mcpCaptureExtensions } from "./mcp-curation"
import { mcpExchange } from "./mcp-exchange"
import { mcpRedact, mcpSettings, type McpRow } from "./mcp-settings"
import { integrationSecrets, mcpChildEnvironment } from "./integration-secrets"

const Command = Schema.Struct({
  server: Schema.NonEmptyString,
  attempt: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  cancel: Schema.optional(Schema.Boolean),
})

export type McpReport = Record<string, Schema.Json> & { server: string; status: string; issue?: string }

/** Nexus owns the declarations and scoped settings; OpenCode owns transports and credentials. */
export async function activateMcp(
  api: ExtensionAPI,
  host: Pick<HostTools, "mcp" | "integration">,
  settings = mcpSettings(api.configuration.servers, api.directory),
  ledger: { agent: readonly AnnouncedTool[]; runner: readonly AnnouncedTool[] } = {
    agent: api.announced?.("agent") ?? [],
    runner: api.announced?.("runner") ?? [],
  },
  reports: McpReport[] = [],
) {
  const mcp = await host.mcp(api.directory)
  const scope = await Effect.runPromise(Scope.make())
  const skippedSchemas: string[] = []
  const issues = settings.faults.map((fault) => fault.key + ": " + fault.issue)
  for (const fault of settings.faults) reports.push({ server: fault.key, status: "down", issue: fault.issue })
  const credentials = new Map<string, string[]>()
  const staticSecrets = new Map([...settings.rows, ...settings.probes.values()].map((row) => [row.server, row.secrets]))
  const refreshSecrets = async (row: McpRow, name = row.server) => {
    if (row.transport === "stdio") return

    const server = (await Effect.runPromise(mcp.servers())).find((server) => server.name === name)

    if (!server?.integrationID) return

    const integration = await host.integration(api.directory)
    const active = await Effect.runPromise(integration.connection.active(server.integrationID))
    const value = active && (await Effect.runPromise(integration.connection.resolve(active)))
    row.oauth = value?.type === "oauth"
    const current = value?.type === "oauth" ? [value.access, value.refresh] : value?.type === "key" ? [value.key] : []
    const tokens = [...new Set([...current, ...(credentials.get(row.server) ?? [])])]
      .filter((value) => Buffer.byteLength(value) >= 8)
      .slice(0, 4)

    credentials.set(row.server, tokens)
    row.secrets = integrationSecrets([...(staticSecrets.get(row.server) ?? []), ...tokens])
  }

  api.onShutdown(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  api.describeStatus(() => ({ ready: !issues.length, issues: [...issues, ...skippedSchemas] }))
  const register = (row: McpRow, config: NonNullable<McpRow["config"]>, scope: Scope.Scope, probe?: string) =>
    Effect.runPromise(
      mcp
        .transform((editor) => {
          editor.set(
            probe ?? row.server,
            config.type === "local"
              ? { ...config, environment: mcpChildEnvironment(config.environment ?? {}) }
              : config,
            {
              credentialKey: row.credentialKey,
              redactErrors: true,
              replaceStdioEnvironment: config.type === "local",
              readOnlyCredentials: probe !== undefined,
              roots: false,
              elicitation: false,
              listChanged: false,
              events: false,
              reconnectOnFailure: true,
            },
          )
        })
        .pipe(Scope.provide(scope)),
      { signal: api.signal },
    )
  const registrations = new Map<string, Effect.Effect<void>>()
  for (const row of settings.rows) {
    if (!row.config) continue
    const registration = await register(row, row.config, scope)

    registrations.set(row.server, registration.dispose)
  }

  // Config plugins load asynchronously. One-shot clients wait for their selected catalog here.
  const selected = settings.rows.filter((row) => row.enabled)
  await Effect.runPromise(
    mcp.servers().pipe(
      Effect.repeat({
        until: (servers) => selected.every((row) => servers.some((server) => server.name === row.server)),
        schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "5 seconds" })),
      }),
    ),
    { signal: api.signal },
  )
  await Effect.runPromise(mcp.awaitStartup(), { signal: api.signal })
  await Effect.runPromise(
    mcp.servers().pipe(
      Effect.repeat({
        until: (servers) =>
          selected.every((row) => servers.find((server) => server.name === row.server)?.status.status !== "pending"),
        schedule: Schedule.spaced("25 millis").pipe(
          Schedule.upTo({ duration: Math.max(30000, ...selected.map((row) => row.config?.timeout?.startup ?? 30000)) }),
        ),
      }),
    ),
    { signal: api.signal },
  )

  const servers = await Effect.runPromise(mcp.servers(), { signal: api.signal })
  const budgets = { ...ledger }
  const catalog = (server: string) =>
    Effect.runPromise(
      Effect.all(
        {
          tools: mcp.advertisedTools(server),
          prompts: mcp.serverPrompts({ server }),
          resources: mcp.resources({ server }),
        },
        { concurrency: "unbounded" },
      ).pipe(Effect.result),
      { signal: api.signal },
    )

  for (const row of settings.rows) {
    await refreshSecrets(row).catch(() => {})
    const server = servers.find((server) => server.name === row.server)
    const report: McpReport = {
      server: row.key,
      transport: row.transport,
      serves: row.role,
      status: row.enabled ? (server?.status.status ?? "down") : "disabled",
    }

    reports.push(report)
    if (!row.enabled) continue
    if (!server || server.status.status !== "connected") {
      const issue = !server
        ? "Server is not registered"
        : "error" in server.status
          ? mcpRedact(server.status.error, row)
          : server.status.status

      report.issue = issue
      issues.push(row.key + ": " + issue)
      continue
    }

    const reject = async (issue: string) => {
      report.status = "down"
      report.issue = mcpRedact(issue, row)
      issues.push(row.key + ": " + report.issue)
      await Effect.runPromise(registrations.get(row.server) ?? Effect.void)
    }
    const listed = await catalog(row.server)
    if (listed._tag === "Failure") {
      await reject(listed.failure.message)
      continue
    }
    const curated = curateMcp(row, listed.success.tools)
    const entries = [...budgets[row.role], ...curated.tools.map((tool) => tool.definition)]
    const fault =
      curated.fault ??
      (mcpAnnouncementBytes(entries) > 65536 ? "Tool declarations exceed the 65536 byte budget for " + row.role : null)

    report.bytes = curated.bytes
    report.skipped = curated.skipped
    for (const tool of curated.skipped)
      if (tool.reason === "Invalid object JSON Schema")
        skippedSchemas.push(row.key + ": " + tool.name + ": " + tool.reason)
    if (fault) {
      await reject(fault)
      continue
    }

    budgets[row.role] = entries
    report.tools = curated.tools.map((tool) => ({
      name: tool.definition.name,
      raw_name: tool.raw,
      bytes: tool.bytes,
      profile_source: row.profiles[tool.raw] ? "operator" : "worst case",
    }))

    const exchange = mcpExchange(mcp, row)

    for (const tool of curated.tools)
      api.registerTool({
        definition: tool.definition,
        role: row.role,
        internalTimeout: true,
        async execute(input, context) {
          try {
            await refreshSecrets(row)
            const response = await exchange(
              (onSessionRenewed) =>
                mcp.callTool({ server: row.server, name: tool.raw, args: input, onSessionRenewed }).pipe(
                  Effect.catchTag("MCP.ToolCallError", (error) =>
                    error.code === -32602
                      ? Effect.succeed({
                          isError: true,
                          content: [{ type: "text" as const, text: "The server refused the call: " + error.message }],
                        })
                      : Effect.fail(error),
                  ),
                ),
              context.signal,
            )

            await refreshSecrets(row)
            const result = await mcpResult(response.result, row, context)

            if (response.notice) result.content.unshift({ type: "text", text: response.notice })
            return result
          } catch (error) {
            await refreshSecrets(row).catch(() => {})
            context.signal.throwIfAborted()
            throw new Error(mcpRedact(error instanceof Error ? error.message : String(error), row))
          }
        },
      })

    const documents = curateMcpDocuments(row, listed.success.prompts, listed.success.resources.resources)

    report.documents = documents.documents.map((document) => ({ name: document.name, kind: document.kind }))
    report.skipped_documents = documents.skipped
    for (const document of documents.documents)
      api.registerDocument({
        name: document.name,
        description: document.description,
        role: row.role,
        async load(context) {
          try {
            await refreshSecrets(row)
            if (document.kind === "resource") {
              const response = await exchange(
                (onSessionRenewed) => mcp.readResource({ server: row.server, uri: document.uri!, onSessionRenewed }),
                context.signal,
              )
              const resource = response.result

              if (!resource) throw new Error("Document is no longer available: " + document.name)

              await refreshSecrets(row)
              const result = await mcpResult(
                {
                  isError: false,
                  content: resource.contents.map((part) =>
                    part.type === "text"
                      ? { type: "text", text: part.text }
                      : {
                          type: "media",
                          data: part.blob,
                          mimeType: part.mimeType ?? "application/octet-stream",
                          uri: part.uri,
                        },
                  ),
                },
                row,
                context,
                document.name,
              )

              if (response.notice) result.content.unshift({ type: "text", text: response.notice })
              return result
            }

            const response = await exchange(
              (onSessionRenewed) => mcp.prompt({ server: row.server, name: document.raw, onSessionRenewed }),
              context.signal,
            )
            const prompt = response.result

            if (!prompt) throw new Error("Document is no longer available: " + document.name)

            await refreshSecrets(row)
            const content: JsonObject[] = response.notice ? [{ type: "text", text: response.notice }] : []

            for (const [index, message] of prompt.messages.entries()) {
              if (message.role === "assistant") content.push({ type: "text", text: "assistant:" })

              const part = message.content

              if (part.type === "text") content.push({ type: "text", text: mcpRedact(part.text, row) })
              if (part.type === "image" || part.type === "audio")
                content.push(...(await mcpMedia(part, row, context, document.name + "-" + index)))
              if (part.type === "resource") {
                if ("text" in part.resource) content.push({ type: "text", text: mcpRedact(part.resource.text, row) })
                if ("blob" in part.resource)
                  content.push(
                    ...(await mcpMedia(
                      {
                        data: part.resource.blob,
                        mimeType: part.resource.mimeType ?? "application/octet-stream",
                        uri: part.resource.uri,
                      },
                      row,
                      context,
                      document.name + "-" + index,
                    )),
                  )
              }
              if (part.type === "resource_link")
                content.push({
                  type: "text",
                  text: mcpRedact("resource: " + part.uri + " (" + (part.mimeType ?? "unknown type") + ")", row),
                })
            }

            return { content }
          } catch (error) {
            await refreshSecrets(row).catch(() => {})
            return {
              is_error: true,
              content: [{ type: "text", text: mcpRedact(error instanceof Error ? error.message : String(error), row) }],
            }
          }
        },
      })
  }

  api.registerCommand("mcp.list", async () => reports)
  api.registerCommand("mcp.probe", async (input) => {
    const command = Schema.decodeUnknownSync(Command)(input)
    const report = reports.find((row) => row.server === command.server)

    if (!report) throw new Error("Unknown MCP server: " + command.server)

    const row = settings.rows.find((row) => row.key === command.server) ?? settings.probes.get(command.server)
    if (!row?.config) return report
    const scope = await Effect.runPromise(Scope.make())
    const name = row.server + "-probe-" + crypto.randomUUID()
    try {
      await register(row, { ...row.config, disabled: false }, scope, name)
      const servers = await Effect.runPromise(
        mcp.servers().pipe(
          Effect.repeat({
            until: (servers) => servers.some((server) => server.name === name && server.status.status !== "pending"),
            schedule: Schedule.spaced("25 millis").pipe(
              Schedule.upTo({ duration: row.config.timeout?.startup ?? 30000 }),
            ),
          }),
        ),
        { signal: api.signal },
      )
      await refreshSecrets(row, name).catch(() => {})
      const server = servers.find((server) => server.name === name)
      if (server?.status.status !== "connected")
        return {
          ...report,
          status: "down",
          issue:
            server && "error" in server.status ? mcpRedact(server.status.error, row) : "MCP probe did not connect.",
        }
      const listed = await catalog(name)
      if (listed._tag === "Failure")
        return {
          server: row.key,
          transport: row.transport,
          serves: row.role,
          status: "down",
          issue: mcpRedact(listed.failure.message, row),
        }
      const curated = curateMcp(row, listed.success.tools)
      const documents = curateMcpDocuments(row, listed.success.prompts, listed.success.resources.resources)
      return Schema.decodeUnknownSync(Schema.MutableJson)({
        server: row.key,
        transport: row.transport,
        serves: row.role,
        status: curated.fault ? "down" : "connected",
        ...(curated.fault ? { issue: curated.fault } : {}),
        tools: curated.tools.map((tool) => ({ name: tool.definition.name, raw_name: tool.raw, bytes: tool.bytes })),
        bytes: curated.bytes,
        skipped: curated.skipped,
        documents: documents.documents,
        skipped_documents: documents.skipped,
        templates: listed.success.resources.templates,
      })
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
  for (const action of ["enable", "disable"] as const)
    api.registerCommand("mcp." + action, async (input) => {
      const command = Schema.decodeUnknownSync(Command)(input)

      if (!settings.rows.some((row) => row.key === command.server))
        throw new Error("Unknown MCP server: " + command.server)
      if (Array.isArray(api.configuration.servers))
        throw new Error("Enable and disable selected OpenCode servers in OpenCode's MCP configuration.")

      return (await api.configure([
        { op: "set", path: ["servers", command.server, "enabled"], value: action === "enable" },
      ])) as Schema.Json
    })
  for (const action of ["login", "logout"] as const)
    api.registerCommand("mcp." + action, async (input) => {
      const command = Schema.decodeUnknownSync(Command)(input)
      const row = settings.rows.find((row) => row.key === command.server)
      const server = row && (await Effect.runPromise(mcp.servers())).find((server) => server.name === row.server)

      if (!server?.integrationID) throw new Error("This MCP server does not offer OAuth.")

      const integration = await host.integration(api.directory)
      const info = await Effect.runPromise(integration.get(server.integrationID))

      if (action === "logout") {
        if (info)
          await Promise.all(
            info.connections
              .filter((connection) => connection.type === "credential")
              .map((connection) => Effect.runPromise(integration.connection.remove(connection.id))),
          )
        await Effect.runPromise(mcp.connect(server.name))
        return { status: "logged_out" }
      }
      if (command.attempt) {
        const attempt = { integrationID: server.integrationID, attemptID: Integration.AttemptID.make(command.attempt) }

        if (command.cancel) {
          await Effect.runPromise(integration.oauth.cancel(attempt))
          return { status: "cancelled" }
        }

        await Effect.runPromise(integration.oauth.complete({ ...attempt, code: command.code }))
        await Effect.runPromise(mcp.connect(server.name))
        await api.configure([])
        return { status: "connected" }
      }

      const method = info?.methods.find((method) => method.type === "oauth")

      if (!method) throw new Error("This MCP server has no OAuth login method.")

      return Schema.decodeUnknownSync(Schema.Json)(
        Schema.encodeSync(Integration.Attempt)(
          await Effect.runPromise(
            integration.oauth.connect({ integrationID: server.integrationID, methodID: method.id }),
          ),
        ),
      )
    })
}

export async function mcpResult(result: Mcp.ToolResult, row: McpRow, context: RunnerContext, document?: string) {
  const blocks = await Promise.all(
    result.content.map((part, index) =>
      part.type === "text"
        ? [{ type: "text", text: mcpRedact(part.text, row) }]
        : mcpMedia(part, row, context, document && (index ? document + "-" + index : document)),
    ),
  )
  const content = blocks.flat()
  const structured =
    result.structured === undefined
      ? undefined
      : redactJson(Schema.decodeUnknownSync(Schema.MutableJson)(result.structured), row)

  if (structured !== undefined && !content.some((part) => part.type === "text" && part.text !== ""))
    content.unshift({ type: "text", text: JSON.stringify(structured) })

  return { is_error: result.isError, content, ...(structured === undefined ? {} : { structured_content: structured }) }
}

async function mcpMedia(
  part: { data: string; mimeType: string; uri?: string },
  row: McpRow,
  context: RunnerContext,
  document?: string,
): Promise<JsonObject[]> {
  const mime = part.mimeType
  const extension = mcpCaptureExtensions.get(mime) ?? (!part.uri && mime.startsWith("image/") ? "bin" : undefined)

  if (!extension || (!context.artifacts && !context.publish))
    return [
      {
        type: "text",
        text: mcpRedact(
          part.uri
            ? "[resource: " + part.uri + " (" + mime + "), content discarded]"
            : "[" + mime + " content discarded]",
          row,
        ),
      },
    ]

  const maximum = 16 * 1024 * 1024
  if (part.data.length > Math.ceil(maximum / 3) * 4) throw new Error("MCP media exceeds 16 MiB.")

  const bytes = Buffer.from(part.data, "base64")
  if (bytes.length > maximum) throw new Error("MCP media exceeds 16 MiB.")

  const server = row.key.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
  const kind = part.uri ? "resource" : "image"
  const name = "mcp-" + server + "-" + (document ?? kind) + "-" + digest + "." + extension
  const path = context.artifacts ? join(context.artifacts, name) : undefined

  context.signal.throwIfAborted()
  if (path) {
    await mkdir(context.artifacts!, { recursive: true, mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600, signal: context.signal })
  }
  const capture = context.publish ? await context.publish(new Blob([bytes], { type: mime }), name) : undefined
  const text = mcpRedact(
    "[" +
      kind +
      ": " +
      mime +
      ", " +
      bytes.length +
      " bytes" +
      (path ? " — saved at " + path : "") +
      (capture ? " and attached" : "") +
      "]",
    row,
  )

  return [{ type: "text", text }, ...(capture ? [capture] : [])]
}

function redactJson(value: Schema.MutableJson, row: McpRow): Schema.MutableJson {
  if (typeof value === "string") return mcpRedact(value, row)
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, row))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [mcpRedact(key, row), redactJson(entry, row)]),
    )

  return value
}
