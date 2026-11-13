import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schedule, Schema } from "effect"
import type { AnnouncedTool, CommitTask, JsonObject } from "@cybros/agent"
import type { HostTools } from "./host"

export type RunnerContext = {
  workspace: string
  conversation: string | null
  run: string
  task: string
  directory: string
  signal: AbortSignal
  publish?: (file: Blob, name: string) => Promise<JsonObject>
  ask?: (key: string, prompt: string, options?: string[]) => Promise<string>
}
export type RunnerTool = {
  definition: AnnouncedTool
  execute(input: JsonObject, context: RunnerContext): Promise<Omit<CommitTask, "claim_token">>
}
export type NexusExtension = (context: {
  directory: string
  signal: AbortSignal
}) => Promise<RunnerTool[]> | RunnerTool[]
export const openWrite = {
  kind: "write",
  destructive: true,
  effect_scope: "open",
  idempotency: "none",
  reconciliation: "none",
} as const
export function definition(
  name: string,
  description: string,
  properties: JsonObject,
  required: string[],
): AnnouncedTool {
  return {
    name,
    description,
    effect_profile: openWrite,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  }
}
const string = { type: "string" }

export async function loadExtensions(directory: string, signal: AbortSignal, host?: HostTools) {
  const tools: RunnerTool[] = []
  const configured = process.env.OPENCODE_NEXUS_EXTENSIONS
  if (configured) {
    const files = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(configured)
    for (const file of files) {
      if (!isAbsolute(file)) throw new Error("Nexus extension modules require absolute paths.")
      const module = await import(pathToFileURL(file).href)
      if (typeof module.default !== "function") throw new Error("Expected a Nexus extension default export.")
      const register: NexusExtension = module.default
      tools.push(...(await register({ directory, signal })))
    }
  }
  if (process.env.OPENCODE_NEXUS_CHROMIUM) {
    const { browserTools } = await import("./browser")
    tools.push(...browserTools(process.env.OPENCODE_NEXUS_CHROMIUM, signal))
  }
  if (process.env.OPENCODE_NEXUS_ACP_AGENTS) {
    const { acpTool } = await import("./acp")
    tools.push(acpTool(process.env.OPENCODE_NEXUS_ACP_AGENTS))
  }
  if (process.env.OPENCODE_NEXUS_T3_URL) {
    const { t3Tools } = await import("./t3")
    tools.push(...t3Tools(process.env.OPENCODE_NEXUS_T3_URL))
  }
  if (!host) return tools
  const ptys = new Map<string, { owner: string; output: string; close(): Promise<void> }>()
  signal.addEventListener(
    "abort",
    () => {
      for (const session of ptys.values()) void session.close().catch(() => {})
      ptys.clear()
    },
    { once: true },
  )
  tools.push({
    definition: definition(
      "terminal",
      "Open, read, write or close an interactive project terminal in this conversation.",
      {
        action: { enum: ["open", "read", "write", "close"] },
        id: string,
        text: string,
      },
      ["action"],
    ),
    async execute(input, ctx) {
      if (!ctx.conversation) throw new Error("A conversation must own the terminal.")
      const owner = JSON.stringify([ctx.workspace, ctx.conversation])
      const pty = await host.pty(directory)
      if (input.action === "open") {
        const info = await Effect.runPromise(pty.create({ cwd: directory, title: "Nexus" }), { signal: ctx.signal })
        const state = { owner, output: "", close: () => Effect.runPromise(pty.remove(info.id)) }
        const attachment = await Effect.runPromise(
          pty.attach(info.id, {
            onData: (chunk) => {
              state.output = (state.output + chunk).slice(-65536)
            },
            onEnd: (event) => {
              state.output += "\n[terminal exited " + (event.exitCode ?? "") + "]"
            },
          }),
        ).catch(async (error) => {
          await state.close()
          throw error
        })
        state.output = attachment.replay
        attachment.activate()
        if (signal.aborted || ctx.signal.aborted) {
          await state.close()
          throw new Error("Terminal opening canceled.")
        }
        ptys.set(info.id, state)
        return { content: info.id }
      }
      const id = input.id
      if (typeof id !== "string") throw new Error("Expected a terminal ID.")
      const state = ptys.get(id)
      if (!state || state.owner !== owner) throw new Error("Unknown conversation terminal.")
      if (input.action === "close") {
        await state.close()
        ptys.delete(id)
        return { content: "Closed." }
      }
      if (input.action === "write" && typeof input.text === "string") {
        const { Pty } = await import("@opencode/core/pty")
        await Effect.runPromise(pty.write(Pty.ID.make(id), input.text), { signal: ctx.signal })
      } else if (input.action !== "read") throw new Error("Expected a terminal action.")
      const output = state.output
      state.output = ""
      return { content: output }
    },
  })
  // Only expose MCP servers explicitly selected for this Nexus installation.
  const selected = process.env.OPENCODE_NEXUS_MCP?.split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (!selected?.length) return tools
  const mcp = await host.mcp(directory)
  // The config plugin registers servers asynchronously on a cold Location. This runner
  // publishes a single catalog, so wait on the client side for its selected entries.
  const servers = await Effect.runPromise(
    mcp.servers().pipe(
      Effect.repeat({
        until: (rows) => selected.every((name) => rows.some((row) => row.name === name)),
        schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "5 seconds" })),
      }),
    ),
    { signal },
  )
  const missing = selected.filter((name) => !servers.some((row) => row.name === name))
  if (missing.length) throw new Error("Configured Nexus MCP servers were not registered: " + missing.join(", "))
  await Effect.runPromise(mcp.awaitStartup(), { signal })
  const discovered = await Effect.runPromise(mcp.tools(), { signal })
  const failed = (await Effect.runPromise(mcp.servers(), { signal })).filter(
    (row) => selected.includes(row.name) && row.status.status !== "connected",
  )
  if (failed.length)
    throw new Error(
      "Nexus MCP servers are unavailable: " + failed.map((row) => row.name + " (" + row.status.status + ")").join(", "),
    )
  for (const row of discovered.filter((row) => selected.includes(row.server))) {
    const raw = "mcp__" + row.server + "__" + row.name
    const name = /^[a-zA-Z0-9_-]{1,64}$/.test(raw)
      ? raw
      : raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) +
        "_" +
        createHash("sha256").update(raw).digest("hex").slice(0, 12)
    tools.push({
      definition: {
        name,
        effect_profile: openWrite,
        description: row.description ?? row.name,
        input_schema: {
          ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(row.inputSchema),
          type: "object",
        },
      },
      async execute(input, ctx) {
        const result = await Effect.runPromise(mcp.callTool({ server: row.server, name: row.name, args: input }), {
          signal: ctx.signal,
        })
        return {
          is_error: result.isError,
          ...(result.structured === undefined
            ? {}
            : { structured_content: Schema.decodeUnknownSync(Schema.MutableJson)(result.structured) }),
          content: await Promise.all(
            result.content.map(async (part, index): Promise<JsonObject> => {
              if (part.type === "text") return { type: "text", text: part.text }
              if (!ctx.publish) throw new Error("MCP media requires an active Nexus claim.")
              if (part.data.length > Math.ceil((16 * 1024 * 1024) / 3) * 4) throw new Error("MCP media exceeds 16 MiB.")
              return ctx.publish(
                new Blob([Buffer.from(part.data, "base64")], { type: part.mimeType }),
                "mcp-output-" + (index + 1),
              )
            }),
          ),
        }
      },
    })
  }
  return tools
}
