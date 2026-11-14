import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { tmpdir } from "node:os"
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
  AppNodeBuilder.build(LayerNode.group([Mcp.node]), [
    Config.node.replace(Config.testLayer([])),
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
        await accepted.promise
        const replacement = await table.bind({
          ...input,
          servers: [{ ...input.servers[0], url: server.url.href + "replacement" }],
        })
        expect(replacement.tools).toEqual(first.tools)
        expect(await running).toMatchObject({ is_error: true })
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
