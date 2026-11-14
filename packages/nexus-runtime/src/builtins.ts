import { isAbsolute, join } from "node:path"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Schema } from "effect"
import type { HostTools } from "./host"
import { terminalTools } from "./extensions"
import type { ExtensionModule } from "./extension-manager"
import { missing } from "./storage"
import { acpConfiguration } from "./acp-settings"
import { readEffect } from "./runner"
import { mcpConfiguration } from "./mcp-settings"
import { t3Configuration } from "./t3-settings"
import { telegramConfiguration } from "./telegram-settings"
import { memoryReviewExtension } from "./memory-review-extension"
import { skillsExtension } from "./skills"
import { processesExtension } from "./processes"
import { conventionsExtension } from "./conventions"
import { capabilityExtensions } from "./capabilities"

const Browser = Schema.Struct({ executable: Schema.String, idle_seconds: Schema.optional(Schema.Number) })
const ACP = Schema.Struct({ agents: Schema.Record(Schema.String, Schema.MutableJson) })
const Terminal = Schema.Struct({
  servers: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          urls: Schema.String,
          username: Schema.optional(Schema.String),
          credential: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  relay: Schema.optional(Schema.Boolean),
  ports: Schema.optional(Schema.mutable(Schema.Tuple([Schema.Int, Schema.Int]))),
  addresses: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export async function builtinExtensions(host?: HostTools, storage?: string): Promise<ExtensionModule[]> {
  const modules: ExtensionModule[] = [
    memoryReviewExtension(),
    skillsExtension(),
    ...(storage ? [processesExtension(storage)] : []),
    conventionsExtension(storage),
    ...capabilityExtensions(),
    {
      descriptor: {
        id: "nexus.ingress-telegram",
        name: "Telegram",
        description: "Connect application Bots to private chats, groups and forum topics.",
        default_enabled: false,
        configuration_version: 1,
        configuration_schema: telegramConfiguration,
        defaults: { connections: {}, bots: {} },
      },
      async register(api) {
        const { TelegramIngress } = await import("./telegram-ingress")
        const ingress = new TelegramIngress(api.configuration, {
          application: api.application,
          signal: api.signal,
          configure: api.configure,
        })

        api.on("member.connected", () => {
          void ingress.run()
        })
        api.on("conversation.binding", (value) => {
          const binding = Schema.decodeUnknownSync(
            Schema.Struct({ workspace: Schema.String, conversation: Schema.String }),
          )(value)
          return ingress.binding(binding.workspace, binding.conversation)
        })
        api.onShutdown(() => ingress.close())
        api.describeStatus(() => {
          const status = ingress.status()
          const issues = status.connections.flatMap((connection) => (connection.issue ? [connection.issue] : []))

          return { ready: !issues.length, issues }
        })
        for (const name of [
          "telegram.status",
          "telegram.connections",
          "telegram.connection.check",
          "telegram.connection.save",
          "telegram.connection.remove",
          "telegram.bot.configure",
          "telegram.access",
          "telegram.deliveries",
          "telegram.delivery.retry",
        ])
          api.registerCommand(name, (input) => ingress.command(Schema.decodeUnknownSync(Schema.MutableJson)(input)))
      },
    },
    {
      descriptor: {
        id: "nexus.web-tools",
        name: "Web reader",
        description: "Read HTTP(S) pages, with bounded responses and same-site redirects.",
        default_enabled: true,
        configuration_version: 1,
        configuration_schema: {
          type: "object",
          properties: { allow_private_network: { type: "boolean" } },
          additionalProperties: false,
        },
        defaults: { allow_private_network: false },
      },
      async register(api) {
        const { webFetch } = await import("./web")
        const configuration = Schema.decodeUnknownSync(Schema.Struct({ allow_private_network: Schema.Boolean }))(
          api.configuration,
        )
        const input = Schema.Struct({ url: Schema.NonEmptyString })

        api.registerTool({
          definition: {
            name: "web_fetch",
            description:
              "Fetch a fully formed HTTP(S) URL. HTML becomes Markdown; other text is returned verbatim. Output is limited to 2000 lines or 50KB, with the full rendering saved to the file named in the result; continue with read on that path. Images and other binary responses are saved as readable files and attached. Cross-site redirects require a separate call. Use web_fetch instead of curl or wget for reading web content.",
            effect_profile: { ...readEffect, effect_scope: "open" },
            timeout_ms: 60000,
            input_schema: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
              additionalProperties: false,
            },
          },
          internalTimeout: true,
          async execute(value, context) {
            if (!context.publish) throw new Error("Web fetch requires an upload context.")

            return webFetch(Schema.decodeUnknownSync(input)(value).url, context.signal, context.publish, {
              allowPrivateNetwork: configuration.allow_private_network,
              artifacts: context.artifacts,
            })
          },
        })
        api.registerCommand("web.fetch", async (value) => {
          const result = await webFetch(
            Schema.decodeUnknownSync(input)(value).url,
            api.signal,
            (file, name) => api.application().publish(file, name, { signal: api.signal }),
            { allowPrivateNetwork: configuration.allow_private_network, raw: true },
          )

          return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(result))
        })
      },
    },
    {
      descriptor: {
        id: "nexus.t3",
        name: "Coding delegation",
        description: "Delegate coding work to a T3 service.",
        default_enabled: !!process.env.OPENCODE_NEXUS_T3_URL,
        configuration_version: 1,
        configuration_schema: t3Configuration,
        defaults: {
          url: process.env.OPENCODE_NEXUS_T3_URL ?? "",
          token: process.env.OPENCODE_NEXUS_T3_TOKEN ?? "",
          project: process.env.OPENCODE_NEXUS_T3_PROJECT ?? "",
        },
      },
      async register(api) {
        if (!storage) throw new Error("T3 requires runtime storage.")
        const { T3Client } = await import("./t3")
        const client = new T3Client(api.configuration, {
          application: api.application,
          directory: api.directory,
          storage: join(storage, "t3"),
          signal: api.signal,
          configure: api.configure,
        })

        api.onShutdown(() => client.close())
        api.describeStatus(() => client.status())
        await client.start()
        client.tools().forEach(api.registerTool)
        for (const name of [
          "t3.status",
          "t3.agents",
          "t3.projects",
          "t3.check",
          "t3.login",
          "t3.token",
          "t3.project",
          "t3.create",
        ])
          api.registerCommand(name, (input) => client.command(Schema.decodeUnknownSync(Schema.MutableJson)(input)))
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
          properties: {
            executable: { type: "string" },
            idle_seconds: { type: "number", exclusiveMinimum: 0, default: 600 },
          },
          required: ["executable"],
          additionalProperties: false,
        },
        defaults: { executable: process.env.OPENCODE_NEXUS_CHROMIUM ?? "" },
      },
      async register(api) {
        const configuration = Schema.decodeUnknownSync(Browser)(api.configuration)

        if (!configuration.executable) throw new Error("Configure a Chromium executable before enabling Browser.")

        const { browserTools } = await import("./browser")
        const { BrowserSession } = await import("./browser-session")
        const session = new BrowserSession(configuration.executable, api.signal, {
          idle: (configuration.idle_seconds ?? 600) * 1000,
        })

        api.onShutdown(() => session.close())
        await session.check()
        browserTools(configuration.executable, api.signal, session).forEach(api.registerTool)
      },
    },
    {
      descriptor: {
        id: "nexus.acp-client",
        name: "ACP delegation",
        description: "Delegate work to configured ACP agents.",
        default_enabled: !!process.env.OPENCODE_NEXUS_ACP_AGENTS,
        configuration_version: 2,
        restart_only: true,
        configuration_schema: acpConfiguration,
        migrate: (configuration) => configuration,
        defaults: {
          agents: process.env.OPENCODE_NEXUS_ACP_AGENTS
            ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(process.env.OPENCODE_NEXUS_ACP_AGENTS)
            : {},
        },
      },
      async register(api) {
        const configuration = Schema.decodeUnknownSync(ACP)(api.configuration)
        const { AcpClient } = await import("./acp")
        const client = new AcpClient(configuration.agents, {
          storage: storage ? join(storage, "acp") : undefined,
          directory: api.directory,
          protectedRoots: storage ? [storage] : [],
          signal: api.signal,
        })
        api.onShutdown(() => client.close())
        api.on("host.ended", async (value) => {
          const ended = Schema.decodeUnknownSync(
            Schema.Struct({ workspace: Schema.String, conversation: Schema.String }),
          )(value)

          await client.release(ended.workspace, ended.conversation)
        })
        api.describeStatus(() => client.status())
        await client.check()
        const tool = client.tool()
        if (tool) api.registerTool(tool)
        for (const name of ["acp.list", "acp.probe", "acp.sessions", "acp.kill", "acp.logs", "acp.release"])
          api.registerCommand(name, (input) => client.command(input))
      },
    },
    {
      descriptor: {
        id: "nexus.mcp",
        name: "MCP",
        description: "Expose selected OpenCode MCP servers to Nexus.",
        default_enabled: !!process.env.OPENCODE_NEXUS_MCP,
        configuration_version: 1,
        configuration_schema: mcpConfiguration,
        defaults: {
          servers:
            process.env.OPENCODE_NEXUS_MCP?.split(",")
              .map((name) => name.trim())
              .filter(Boolean) ?? [],
        },
      },
      async register(api) {
        if (!host) throw new Error("MCP requires OpenCode host services.")

        const { activateMcp } = await import("./mcp")

        await activateMcp(api, host)
      },
    },
    {
      descriptor: {
        id: "nexus.terminal",
        name: "Terminal",
        description: "Interactive project terminals owned by conversations.",
        default_enabled: !!host,
        configuration_version: 1,
        configuration_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            servers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  urls: { type: "string" },
                  username: { type: "string" },
                  credential: { type: "string", writeOnly: true },
                },
                required: ["urls"],
                additionalProperties: false,
              },
            },
            relay: { type: "boolean" },
            ports: { type: "array", items: { type: "integer", minimum: 1, maximum: 65535 }, minItems: 2, maxItems: 2 },
            addresses: { type: "array", items: { type: "string" } },
          },
        },
        defaults: {},
      },
      register(api) {
        if (!host) throw new Error("Terminal requires OpenCode host services.")

        const options = Schema.decodeUnknownSync(Terminal)(api.configuration)
        if (options.ports && options.ports[0] > options.ports[1])
          throw new Error("Terminal ICE port range must be ascending.")
        terminalTools(api.directory, api.signal, host, options).forEach(api.registerTool)
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
        const { workerRegistration } = await import("./worker-extension")
        await workerRegistration(file, { legacy: true })(api)
      },
    })
  }

  return modules
}
