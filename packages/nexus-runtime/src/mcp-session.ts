import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { AnnouncedTool } from "@cybros/agent"
import type { HostTools } from "./host"
import type { RunnerTool } from "./extensions"
import { activateMcp } from "./mcp"
import { mcpSettings } from "./mcp-settings"

const Pair = Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String })
export const EditorMcpServers = Schema.Array(
  Schema.Union([
    Schema.Struct({
      name: Schema.NonEmptyString,
      type: Schema.optional(Schema.Literal("stdio")),
      command: Schema.NonEmptyString,
      args: Schema.optional(Schema.Array(Schema.String)),
      env: Schema.optional(Schema.Array(Pair)),
    }),
    Schema.Struct({
      name: Schema.NonEmptyString,
      type: Schema.Literal("http"),
      url: Schema.NonEmptyString,
      headers: Schema.optional(Schema.Array(Pair)),
    }),
    Schema.Struct({ name: Schema.NonEmptyString, type: Schema.Literals(["sse", "acp"]) }),
  ]),
)

export async function mcpSession(
  input: {
    workspace: string
    conversation: string
    directory: string
    servers: unknown
    signal: AbortSignal
    ledger?: readonly AnnouncedTool[]
  },
  host: Pick<HostTools, "mcp" | "integration">,
) {
  const entries = Schema.decodeUnknownSync(EditorMcpServers)(input.servers)

  if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
    throw new Error("The editor supplied duplicate MCP server names.")

  const tools: RunnerTool[] = []
  const issues: string[] = []
  const diagnostics = { read: () => ({ ready: true, issues: [] as string[] }) }
  const closures: Array<() => Promise<void> | void> = []
  const names = new Map<string, string>()
  const table = Object.fromEntries(
    entries.flatMap((entry) => {
      if (!("command" in entry) && !("url" in entry)) {
        issues.push(entry.name + ": transport " + entry.type + " unsupported")
        return []
      }

      const key =
        "acp-" +
        createHash("sha256")
          .update(JSON.stringify([input.workspace, input.conversation, entry.name]))
          .digest("hex")
          .slice(0, 20)

      names.set(key, entry.name)
      return [
        [
          key,
          "url" in entry
            ? {
                transport: "http",
                url: entry.url,
                headers: Object.fromEntries((entry.headers ?? []).map((header) => [header.name, header.value])),
                tools: ["*"],
                serves: "agent",
              }
            : {
                transport: "stdio",
                command: entry.command,
                args: entry.args ?? [],
                env: Object.fromEntries((entry.env ?? []).map((variable) => [variable.name, variable.value])),
                tools: ["*"],
                serves: "agent",
              },
        ],
      ]
    }),
  )
  const settings = mcpSettings(table, input.directory, {}, true)
  for (const row of settings.rows) row.key = names.get(row.key)!
  const active = new Set<Promise<unknown>>()
  const owner = new AbortController()
  const retirement: { pending?: Promise<void> } = {}
  const close = () => {
    if (retirement.pending) return retirement.pending

    retirement.pending = (async () => {
      owner.abort()
      await Promise.allSettled(active)
      await Promise.allSettled(closures.splice(0).map((close) => close()))
      input.signal.removeEventListener("abort", onAbort)
    })()
    return retirement.pending
  }
  const onAbort = () => {
    void close()
  }

  input.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await activateMcp(
      {
        directory: input.directory,
        signal: AbortSignal.any([input.signal, owner.signal]),
        configuration: {},
        application() {
          throw new Error("Editor MCP attachments have no application controls.")
        },
        async configure() {
          throw new Error("Editor MCP attachments are managed by the editor.")
        },
        async registerWebUI() {
          throw new Error("Editor MCP cannot register browser modules.")
        },
        registerTool(tool) {
          tools.push({
            ...tool,
            async execute(value, context) {
              if (
                context.workspace !== input.workspace ||
                (context.anchor ?? context.conversation) !== input.conversation
              )
                throw new Error("This MCP tool belongs to another editor session.")

              if (retirement.pending) throw new Error("This editor MCP attachment has retired.")

              const running = Promise.resolve().then(() =>
                tool.execute(value, {
                  ...context,
                  signal: AbortSignal.any([context.signal, input.signal, owner.signal]),
                }),
              )

              active.add(running)
              try {
                return await running
              } finally {
                active.delete(running)
              }
            },
          })
        },
        registerAgent() {},
        registerConversationServers() {},
        restartOnly() {},
        onStartup() {},
        background() {},
        registerCommand() {},
        registerDocument() {},
        on() {},
        onToolResult() {},
        onShutdown(callback) {
          closures.push(callback)
        },
        describeEnvironment() {},
        describeStatus(status) {
          diagnostics.read = status
        },
      },
      host,
      settings,
      { agent: input.ledger ?? [], runner: [] },
    )
    input.signal.throwIfAborted()

    issues.push(...diagnostics.read().issues)
    return {
      tools,
      issues: issues.map((issue) => [...names].reduce((text, [key, name]) => text.replaceAll(key, name), issue)),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
