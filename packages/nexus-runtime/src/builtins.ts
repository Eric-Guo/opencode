import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Schema } from "effect"
import type { HostTools } from "./host"
import { mcpTools, terminalTools, type NexusExtension } from "./extensions"
import type { ExtensionModule } from "./extension-manager"
import { missing } from "./storage"

const Browser = Schema.Struct({ executable: Schema.String })
const ACP = Schema.Struct({ agents: Schema.Record(Schema.String, Schema.Array(Schema.String)) })
const MCP = Schema.Struct({ servers: Schema.Array(Schema.String) })
const T3 = Schema.Struct({ url: Schema.String, token: Schema.String, project: Schema.String })

export async function builtinExtensions(host?: HostTools): Promise<ExtensionModule[]> {
  const modules: ExtensionModule[] = [
    {
      descriptor: {
        id: "nexus.t3",
        name: "Coding delegation",
        description: "Delegate coding work to a T3 service.",
        default_enabled: !!process.env.OPENCODE_NEXUS_T3_URL,
        configuration_version: 1,
        configuration_schema: {
          type: "object",
          properties: {
            url: { type: "string" },
            token: { type: "string", writeOnly: true },
            project: { type: "string" },
          },
          required: ["url", "token", "project"],
          additionalProperties: false,
        },
        defaults: {
          url: process.env.OPENCODE_NEXUS_T3_URL ?? "",
          token: process.env.OPENCODE_NEXUS_T3_TOKEN ?? "",
          project: process.env.OPENCODE_NEXUS_T3_PROJECT ?? "",
        },
      },
      async register(api) {
        const configuration = Schema.decodeUnknownSync(T3)(api.configuration)
        const { t3Tools } = await import("./t3")

        t3Tools(configuration.url, configuration).forEach(api.registerTool)
      },
    },
    {
      descriptor: {
        id: "nexus.browser",
        name: "Browser",
        description: "Control a browser on this machine.",
        default_enabled: !!process.env.OPENCODE_NEXUS_CHROMIUM,
        configuration_version: 1,
        restart_only: true,
        configuration_schema: {
          type: "object",
          properties: { executable: { type: "string" } },
          required: ["executable"],
          additionalProperties: false,
        },
        defaults: { executable: process.env.OPENCODE_NEXUS_CHROMIUM ?? "" },
      },
      async register(api) {
        const configuration = Schema.decodeUnknownSync(Browser)(api.configuration)

        if (!configuration.executable) throw new Error("Configure a Chromium executable before enabling Browser.")

        const { browserTools } = await import("./browser")

        browserTools(configuration.executable, api.signal).forEach(api.registerTool)
      },
    },
    {
      descriptor: {
        id: "nexus.acp-client",
        name: "ACP delegation",
        description: "Delegate work to configured ACP agents.",
        default_enabled: !!process.env.OPENCODE_NEXUS_ACP_AGENTS,
        configuration_version: 1,
        restart_only: true,
        configuration_schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              additionalProperties: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            },
          },
          required: ["agents"],
          additionalProperties: false,
        },
        defaults: {
          agents: process.env.OPENCODE_NEXUS_ACP_AGENTS
            ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(process.env.OPENCODE_NEXUS_ACP_AGENTS)
            : {},
        },
      },
      async register(api) {
        const configuration = Schema.decodeUnknownSync(ACP)(api.configuration)
        const { acpTool } = await import("./acp")

        api.registerTool(acpTool(JSON.stringify(configuration.agents)))
      },
    },
    {
      descriptor: {
        id: "nexus.mcp",
        name: "MCP",
        description: "Expose selected OpenCode MCP servers to Nexus.",
        default_enabled: !!process.env.OPENCODE_NEXUS_MCP,
        configuration_version: 1,
        configuration_schema: {
          type: "object",
          properties: { servers: { type: "array", items: { type: "string" }, uniqueItems: true } },
          required: ["servers"],
          additionalProperties: false,
        },
        defaults: {
          servers:
            process.env.OPENCODE_NEXUS_MCP?.split(",")
              .map((name) => name.trim())
              .filter(Boolean) ?? [],
        },
      },
      async register(api) {
        if (!host) throw new Error("MCP requires OpenCode host services.")

        const configuration = Schema.decodeUnknownSync(MCP)(api.configuration)
        const tools = await mcpTools(api.directory, api.signal, host, configuration.servers)

        tools.forEach(api.registerTool)
      },
    },
    {
      descriptor: {
        id: "nexus.terminal",
        name: "Terminal",
        description: "Interactive project terminals owned by conversations.",
        default_enabled: !!host,
        configuration_version: 1,
        configuration_schema: { type: "object", additionalProperties: false },
        defaults: {},
      },
      register(api) {
        if (!host) throw new Error("Terminal requires OpenCode host services.")

        terminalTools(api.directory, api.signal, host).forEach(api.registerTool)
      },
    },
  ]
  const paths = process.env.OPENCODE_NEXUS_EXTENSIONS
    ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
        process.env.OPENCODE_NEXUS_EXTENSIONS,
      )
    : []

  for (const file of paths) {
    if (!isAbsolute(file)) throw new Error("Nexus extension modules require absolute paths.")

    // Read metadata without importing executable extension code. Disabled sources stay inert.
    const source = await readFile(file.replace(/\.[^.]+$/, ".json"), "utf8").catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    const descriptor = source
      ? Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              id: Schema.NonEmptyString,
              name: Schema.NonEmptyString,
              description: Schema.String,
              default_enabled: Schema.Boolean,
              configuration_version: Schema.Int,
              configuration_schema: Schema.Record(Schema.String, Schema.MutableJson),
              defaults: Schema.Record(Schema.String, Schema.MutableJson),
              restart_only: Schema.optional(Schema.Boolean),
              requires: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
        )(source)
      : {
          id: "legacy." + createHash("sha256").update(file).digest("hex").slice(0, 12),
          name: file,
          description: "Legacy Nexus extension. Add a sibling JSON descriptor to configure it.",
          default_enabled: true,
          configuration_version: 1,
          configuration_schema: { type: "object", additionalProperties: false } as const,
          defaults: {},
        }

    modules.push({
      descriptor,
      async register(api) {
        const module = await import(pathToFileURL(file).href)

        if (typeof module.register === "function") {
          await module.register(api)
          return
        }

        if (typeof module.default !== "function") throw new Error("Expected an extension register export.")

        const register: NexusExtension = module.default

        const tools = await register({ directory: api.directory, signal: api.signal })

        tools.forEach(api.registerTool)
      },
    })
  }

  return modules
}
