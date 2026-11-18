import { expect } from "bun:test"
import { Effect, Layer, Schema, Scope } from "effect"
import { tmpdir } from "node:os"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { Integration } from "@opencode/core/integration"
import { Credential } from "@opencode/core/credential"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { activateMcp } from "../src/mcp"
import { mcpConfiguration } from "../src/mcp-settings"
import { ExtensionManager } from "../src/extension-manager"
import { Configuration } from "../src/configuration"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../../core/test/fixture/location"
import { testEffect } from "../../core/test/lib/effect"
import { mcpSession } from "../src/mcp-session"
import { McpSessions } from "../src/mcp-sessions"
import { openWrite, type RunnerTool } from "../src/extensions"
import { mcpAnnouncementBytes } from "../src/mcp-curation"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Mcp.node, Integration.node]), [
    Config.node.replace(Config.testLayer([])),
    Global.node.replace(tempGlobalLayer),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmpdir()) }))),
    ),
  ]),
)

it.live("session MCP uses public names and replacement cancels an accepted blocked HTTP call before reopening", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    yield* Effect.promise(async () => {
      const accepted = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const events: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 })
          const message = Schema.decodeUnknownSync(
            Schema.Struct({ id: Schema.optional(Schema.Union([Schema.String, Schema.Number])), method: Schema.String }),
          )(await request.json())
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : message.method === "tools/list"
                ? { tools: [{ name: "read", description: "Read the document", inputSchema: { type: "object" } }] }
                : { content: [{ type: "text", text: "finished" }] }
          if (message.method === "initialize") events.push("initialize")
          if (message.method === "tools/call") {
            events.push("accepted")
            accepted.resolve()
            await released.promise
          }
          return message.id === undefined
            ? new Response(null, { status: 202 })
            : Response.json({ jsonrpc: "2.0", id: message.id, result })
        },
      })
      const boot: RunnerTool[] = []
      const table = new McpSessions(
        () => boot,
        (input) =>
          mcpSession(input, {
            mcp: async () => mcp,
            async integration() {
              throw new Error("Static authorization uses no OAuth integration.")
            },
          }),
        async () => {},
      )
      const input = {
        workspace: "workspace",
        conversation: "anchor",
        directory: tmpdir(),
        signal: new AbortController().signal,
        servers: [
          {
            name: "My Server",
            type: "http",
            url: server.url.href,
            headers: [{ name: "Authorization", value: "fixture" }],
          },
        ],
      }
      try {
        const first = await table.bind(input)
        expect(first.issues).toEqual([])
        expect(first.tools[0]).toStartWith("mcp__My_Server__read_")
        const running = table.tools()[0].execute(
          {},
          {
            workspace: "workspace",
            conversation: "child",
            anchor: "anchor",
            run: "run",
            task: "task",
            directory: tmpdir(),
            signal: new AbortController().signal,
          },
        )
        void running.catch(() => {})
        await accepted.promise
        const replacement = await table.bind({
          ...input,
          servers: [{ ...input.servers[0], url: server.url.href + "replacement" }],
        })
        expect(replacement.tools).toEqual(first.tools)
        await expect(running).rejects.toThrow()
        expect(events).toEqual(["initialize", "accepted", "initialize"])
        await table.bind({ ...input, servers: [] })
        expect(table.tools()).toEqual([])
        boot.push({
          role: "agent",
          definition: {
            name: "large",
            description: "x".repeat(65300),
            input_schema: { type: "object" },
            effect_profile: openWrite,
          },
          async execute() {
            return { content: "large" }
          },
        })
        expect(mcpAnnouncementBytes(boot.map((tool) => tool.definition))).toBeLessThan(65536)
        const crowded = await table.bind(input)
        expect(crowded.tools).toEqual([])
        expect(crowded.issues[0]).toContain("65536 byte budget")
        expect(await Effect.runPromise(mcp.servers())).toEqual([])
      } finally {
        released.resolve()
        await Promise.allSettled([...table.values()].map((row) => row.close()))
        server.stop(true)
      }
    })
  }),
)

it.live("MCP login publishes a previously unavailable catalog while unchanged servers keep their connection", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const integration = yield* Integration.Service
    const context = yield* Effect.context()
    const scope = yield* Effect.scope
    yield* Effect.promise(async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-mcp-login-")))
      const starts = { protected: 0, stable: 0 }
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const name = new URL(request.url).pathname === "/protected" ? "protected" : "stable"
          if (name === "protected" && request.headers.get("authorization") !== "Bearer fixture-access")
            return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
          if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 })
          const message = Schema.decodeUnknownSync(
            Schema.Struct({ id: Schema.optional(Schema.Union([Schema.String, Schema.Number])), method: Schema.String }),
          )(await request.json())
          if (message.method === "initialize") starts[name]++
          const result =
            message.method === "initialize"
              ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }
              : message.method === "tools/list"
                ? { tools: [{ name: "read", description: "Read " + name, inputSchema: { type: "object" } }] }
                : { content: [{ type: "text", text: name }] }
          return message.id === undefined
            ? new Response(null, { status: 202 })
            : Response.json({ jsonrpc: "2.0", id: message.id, result })
        },
      })
      const published = Promise.withResolvers<void>()
      const publication = { notify: published.resolve }
      const manager = new ExtensionManager(
        new Configuration(join(directory, "configuration.json")),
        [
          {
            descriptor: {
              id: "nexus.mcp",
              name: "MCP",
              description: "MCP",
              default_enabled: true,
              configuration_version: 1,
              configuration_schema: mcpConfiguration,
              defaults: {
                servers: {
                  protected: { transport: "http", url: server.url.origin + "/protected", tools: ["*"] },
                  stable: {
                    transport: "http",
                    url: server.url.origin + "/stable",
                    headers: { Authorization: "stable" },
                    tools: ["*"],
                  },
                },
              },
            },
            register: (api) => activateMcp(api, { mcp: async () => mcp, integration: async () => integration }),
          },
        ],
        directory,
        new AbortController().signal,
        async () => {
          publication.notify()
        },
      )
      try {
        await manager.start()
        expect(manager.tools().map((tool) => tool.definition.name)).toEqual(["mcp__stable__read"])
        const protectedRow = (await Effect.runPromiseWith(context)(mcp.servers())).find((row) =>
          row.name.startsWith("nexus-protected-"),
        )!
        const integrationID = protectedRow.integrationID!
        const info = await Effect.runPromiseWith(context)(integration.get(integrationID))
        const methodID = info!.methods.find((method) => method.type === "oauth")!.id
        await Effect.runPromiseWith(context)(
          integration
            .transform((editor) =>
              editor.method.update({
                integrationID,
                method: { id: methodID, type: "oauth", label: "Fixture OAuth" },
                authorize: () =>
                  Effect.succeed({
                    mode: "code" as const,
                    url: server.url.origin + "/authorize",
                    instructions: "Enter fixture code",
                    callback: () =>
                      Effect.succeed(
                        Credential.OAuth.make({
                          type: "oauth",
                          methodID,
                          access: "fixture-access",
                          refresh: "fixture-refresh",
                          expires: Date.now() + 3600000,
                        }),
                      ),
                  }),
              }),
            )
            .pipe(Scope.provide(scope)),
        )
        const attempt = Schema.decodeUnknownSync(Schema.Struct({ attemptID: Schema.String }))(
          await manager.command("mcp.login", { server: "protected" }),
        )
        await manager.command("mcp.login", { server: "protected", attempt: attempt.attemptID, code: "fixture-code" })
        await published.promise
        expect(manager.tools().map((tool) => tool.definition.name)).toEqual([
          "mcp__protected__read",
          "mcp__stable__read",
        ])
        expect(starts.stable).toBe(1)
        expect(starts.protected).toBeGreaterThanOrEqual(1)
        const beforeProbe = starts.protected
        expect(await manager.command("mcp.probe", { server: "protected" })).toMatchObject({ status: "connected" })
        expect(starts.protected).toBe(beforeProbe + 1)
        expect(manager.tools().map((tool) => tool.definition.name)).toEqual([
          "mcp__protected__read",
          "mcp__stable__read",
        ])
        const disabled = Promise.withResolvers<void>()
        publication.notify = () => {
          if (!manager.tools().some((tool) => tool.definition.name === "mcp__protected__read")) disabled.resolve()
        }
        await manager.command("mcp.disable", { server: "protected" })
        await disabled.promise
        const disabledRow = (await Effect.runPromiseWith(context)(mcp.servers())).find((row) =>
          row.name.startsWith("nexus-protected-"),
        )!
        expect(disabledRow.integrationID).toBe(integrationID)
        const enabled = Promise.withResolvers<void>()
        publication.notify = () => {
          if (manager.tools().some((tool) => tool.definition.name === "mcp__protected__read")) enabled.resolve()
        }
        await manager.command("mcp.enable", { server: "protected" })
        await enabled.promise
        const enabledRow = (await Effect.runPromiseWith(context)(mcp.servers())).find((row) =>
          row.name.startsWith("nexus-protected-"),
        )!
        expect(enabledRow.integrationID).toBe(integrationID)
        expect(starts.stable).toBe(1)
      } finally {
        await manager.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }),
)

it.live("MCP tool failures retain their two axes and disabled-server probes open a scoped connection", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    yield* Effect.promise(async () => {
      const calls: string[] = []
      const pdf = Buffer.from("%PDF-1.4\nfixture\n%%EOF")
      const resource = { uri: "fixture://manual", mimeType: "application/pdf", blob: pdf.toString("base64") }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 })
          const message = (await request.json()) as {
            id?: number
            method: string
            params?: { arguments?: { mode?: string } }
          }
          calls.push(message.method)
          const mode = message.params?.arguments?.mode
          if (message.method === "tools/call" && mode === "transport") return new Response(null, { status: 503 })
          if (message.method === "tools/call" && ["arguments", "refused"].includes(mode ?? ""))
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: mode === "arguments" ? -32602 : -32603, message: "fixture-private-secret refusal" },
            })
          const results: Record<string, object> = {
            initialize: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {}, prompts: {}, resources: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
            "tools/list": { tools: [{ name: "probe", description: "Probe", inputSchema: { type: "object" } }] },
            "resources/list": {
              resources: [
                { uri: resource.uri, mimeType: resource.mimeType, name: "manual", description: "Read the manual" },
              ],
            },
            "resources/templates/list": { resourceTemplates: [] },
            "resources/read": { contents: [resource] },
            "prompts/list": { prompts: [{ name: "review", description: "Review the manual" }] },
            "prompts/get": {
              messages: [
                { role: "user", content: { type: "text", text: "Read the manual" } },
                { role: "assistant", content: { type: "resource", resource } },
              ],
            },
            "tools/call": {
              isError: mode === "tool",
              content:
                mode === "media" ? [{ type: "resource", resource }] : [{ type: "text", text: "returned answer" }],
            },
          }
          return message.id === undefined
            ? new Response(null, { status: 202 })
            : Response.json({ jsonrpc: "2.0", id: message.id, result: results[message.method] })
        },
      })
      const directory = await mkdtemp(join(tmpdir(), "nexus-mcp-errors-"))
      const manager = new ExtensionManager(
        new Configuration(join(directory, "configuration.json")),
        [
          {
            descriptor: {
              id: "fixture.mcp",
              name: "MCP",
              description: "MCP",
              default_enabled: true,
              configuration_version: 1,
              configuration_schema: mcpConfiguration,
              defaults: {
                servers: {
                  active: {
                    transport: "http",
                    url: server.url.href,
                    tools: ["*"],
                    headers: { Authorization: "fixture-private-secret" },
                  },
                  parked: {
                    transport: "http",
                    url: server.url.href,
                    tools: ["*"],
                    enabled: false,
                    headers: { Authorization: "fixture-private-secret" },
                  },
                },
              },
            },
            register: (api) =>
              activateMcp(api, {
                mcp: async () => mcp,
                integration: async () => {
                  throw new Error("Static bearer has no OAuth owner")
                },
              }),
          },
        ],
        directory,
        new AbortController().signal,
        async () => {},
      )
      try {
        await manager.start()
        const tool = manager.tools().find((tool) => tool.definition.name === "mcp__active__probe")!
        expect(await manager.command("mcp.list", {})).toMatchObject([
          { server: "active", bytes: 113, tools: [{ name: "mcp__active__probe", bytes: 113 }] },
          { server: "parked", status: "disabled" },
          { server: "context7", status: "disabled" },
        ])
        const context = {
          workspace: "w",
          conversation: "c",
          run: "r",
          task: "t",
          directory,
          signal: new AbortController().signal,
        }
        expect(await tool.execute({ mode: "tool" }, context)).toMatchObject({ is_error: true })
        const artifacts = join(directory, "artifacts")
        const captured = {
          ...context,
          artifacts,
          publish: async (media: Blob, name: string) => {
            expect(media.type).toBe(resource.mimeType)
            expect(Buffer.from(await media.arrayBuffer())).toEqual(pdf)
            expect(await readFile(join(artifacts, name))).toEqual(pdf)
            return { type: "resource_link", uri: "nexus://uploads/fixture", name }
          },
        }
        for (const [name, load] of [
          ["resource", () => tool.execute({ mode: "media" }, captured)],
          ["active-manual", () => manager.readDocument("active-manual", captured, "agent")],
          ["active-review", () => manager.readDocument("active-review", captured, "agent")],
        ] as const) {
          const result = await load()
          expect(result?.content).toEqual([
            ...(name === "active-review"
              ? [
                  { type: "text", text: "Read the manual" },
                  { type: "text", text: "assistant:" },
                ]
              : []),
            { type: "text", text: expect.stringContaining(join(artifacts, "mcp-active-" + name)) },
            { type: "resource_link", uri: "nexus://uploads/fixture", name: expect.stringMatching(/\.pdf$/) },
          ])
        }
        expect((await manager.readDocument("active-manual", context, "agent"))?.content).toEqual([
          { type: "text", text: "[resource: fixture://manual (application/pdf), content discarded]" },
        ])
        const invalid = await tool.execute({ mode: "arguments" }, context)
        expect(invalid).toMatchObject({
          is_error: true,
          content: [{ type: "text", text: expect.stringContaining("[redacted]") }],
        })
        await expect(tool.execute({ mode: "refused" }, context)).rejects.toThrow("[redacted]")
        await expect(tool.execute({ mode: "transport" }, context)).rejects.toThrow()
        expect(manager.tools().some((tool) => tool.definition.name === "mcp__parked__probe")).toBe(false)
        const before = calls.filter((method) => method === "initialize").length
        expect(await manager.command("mcp.probe", { server: "parked" })).toMatchObject({
          status: "connected",
          bytes: 113,
          tools: [{ name: "mcp__parked__probe", bytes: 113 }],
        })
        expect(calls.filter((method) => method === "initialize").length).toBeGreaterThan(before)
        expect(manager.tools().some((tool) => tool.definition.name === "mcp__parked__probe")).toBe(false)
      } finally {
        await manager.close()
        server.stop(true)
        await rm(directory, { recursive: true, force: true })
      }
    })
  }),
)
