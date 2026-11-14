import { expect, test } from "bun:test"
import { Schema } from "effect"
import { McpSessions, mcpSessionDigest } from "../src/mcp-sessions"
import { curateMcp } from "../src/mcp-curation"
import { mcpSettings } from "../src/mcp-settings"
import type { RunnerTool, RunnerContext } from "../src/extensions"

const owner = new AbortController()
const context: RunnerContext = {
  workspace: "workspace",
  conversation: "child",
  anchor: "first",
  run: "run",
  task: "task",
  directory: "/project",
  signal: owner.signal,
}

function candidate(name: string, description = "Read a document"): RunnerTool[] {
  const row = mcpSettings({ fixture: { transport: "stdio", command: "peer", tools: ["*"] } }, "/project").rows[0]
  row.key = name
  return curateMcp(row, [
    { name: "read", description, inputSchema: { type: "object" } },
    { name: "write", description: "Write a document", inputSchema: { type: "object" } },
  ]).tools.map((tool) => ({
    role: "agent",
    definition: tool.definition,
    async execute() {
      return { content: name }
    },
  }))
}

test("session MCP digests exclude secret values and include launch details and credential keys", () => {
  const entries = [{ name: "My Server", command: "peer", args: ["--stdio"], env: [{ name: "KEY", value: "secret" }] }]
  const original = mcpSessionDigest(entries)
  expect(mcpSessionDigest([{ ...entries[0], env: [{ name: "KEY", value: "rotated" }] }])).toBe(original)
  expect(mcpSessionDigest([{ ...entries[0], env: [{ name: "OTHER_KEY", value: "secret" }] }])).not.toBe(original)
  expect(mcpSessionDigest([{ ...entries[0], args: ["--other"] }])).not.toBe(original)
  expect(mcpSessionDigest([{ ...entries[0], name: "Other Server" }])).not.toBe(original)
  expect(
    mcpSessionDigest([
      {
        name: "http",
        type: "http",
        url: "https://example.test",
        headers: [
          { name: "B", value: "one" },
          { name: "A", value: "two" },
        ],
      },
    ]),
  ).toBe(
    mcpSessionDigest([
      {
        name: "http",
        type: "http",
        url: "https://example.test",
        headers: [
          { name: "A", value: "other" },
          { name: "B", value: "rotated" },
        ],
      },
    ]),
  )
})

test("session MCP needs the loaded registrar and cannot retain a connection opened across its unload", async () => {
  const enabled = { value: false }
  const starting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const closed: string[] = []
  const table = new McpSessions(
    () => [],
    async (input) => {
      starting.resolve()
      await release.promise
      return {
        tools: candidate("server"),
        issues: [],
        async close() {
          closed.push(input.conversation)
        },
      }
    },
    async () => {},
    () => enabled.value,
  )
  const input = {
    workspace: "workspace",
    conversation: "first",
    directory: "/project",
    signal: owner.signal,
    servers: [{ name: "server", command: "peer" }],
  }
  await expect(table.bind(input)).rejects.toThrow("mcp_unavailable")
  enabled.value = true
  const binding = table.bind(input).catch((error: unknown) => error)
  await starting.promise
  enabled.value = false
  await table.close()
  release.resolve()
  expect(await binding).toMatchObject({
    message: "mcp_unavailable: the MCP extension was unloaded while attaching editor servers.",
  })
  expect(closed).toEqual(["first"])
  expect(table.tools()).toEqual([])
  expect(await table.bind({ ...input, servers: [] })).toEqual({ tools: [], issues: [] })
})

test("equal session MCP lists keep a down set and replacements close before opening, including failed replacements", async () => {
  const events: string[] = []
  const release = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const table = new McpSessions(
    () => [],
    async (input) => {
      const entries = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ command: Schema.String })))(input.servers)
      events.push("open:" + entries[0].command)
      if (entries[0].command === "broken") throw new Error("Connection failed")
      return {
        tools: [],
        issues: ["server: down"],
        close: async () => {
          events.push("close")
          closing.resolve()
          await release.promise
        },
      }
    },
    async () => {
      events.push("publish")
    },
  )
  const input = {
    workspace: "workspace",
    conversation: "first",
    directory: "/project",
    signal: owner.signal,
    servers: [{ name: "server", command: "peer", env: [{ name: "KEY", value: "secret" }] }],
  }
  expect(await table.bind(input)).toEqual({ tools: [], issues: ["server: down"] })
  expect(
    await table.bind({ ...input, servers: [{ ...input.servers[0], env: [{ name: "KEY", value: "rotated" }] }] }),
  ).toEqual({ tools: [], issues: ["server: down"] })
  expect(events).toEqual(["open:peer", "publish"])
  const replacement = table.bind({ ...input, servers: [{ name: "server", command: "broken" }] })
  const failed = replacement.catch((error: unknown) => error)
  await closing.promise
  expect(events).toEqual(["open:peer", "publish", "close"])
  release.resolve()
  expect(await failed).toMatchObject({ message: "Connection failed" })
  expect(events).toEqual(["open:peer", "publish", "close", "open:broken", "publish"])
  expect(table.get(JSON.stringify(["workspace", "first"]))).toBeUndefined()
})

test("session MCP announcements share exact entries while dispatching by frozen workspace and environment anchor", async () => {
  const closed: string[] = []
  const table = new McpSessions(
    () => [],
    async (input) => ({
      tools: candidate("My Server").map((tool) => ({
        ...tool,
        async execute() {
          return { content: input.conversation }
        },
      })),
      issues: [],
      async close() {
        closed.push(input.conversation)
      },
    }),
    async () => {},
  )
  const input = {
    workspace: "workspace",
    conversation: "first",
    directory: "/project",
    signal: owner.signal,
    servers: [{ name: "My Server", command: "peer" }],
  }
  await table.bind(input)
  await table.bind({ ...input, conversation: "second" })
  expect(table.tools()).toHaveLength(2)
  expect(table.tools()[0].definition.name).toStartWith("mcp__My_Server__read_")
  expect(await table.tools()[0].execute({}, context)).toEqual({ content: "first" })
  expect(await table.tools()[0].execute({}, { ...context, anchor: "second" })).toEqual({ content: "second" })
  expect(() => table.tools()[0].execute({}, { ...context, workspace: "other" })).toThrow("anchor")
  expect(() => table.tools()[0].execute({}, { ...context, anchor: "unbound" })).toThrow("anchor")
  expect(await table.bind({ ...input, servers: [] })).toEqual({ tools: [], issues: [] })
  expect(closed).toEqual(["first"])
  expect(table.get(JSON.stringify(["workspace", "first"]))).toBeUndefined()
  expect(table.tools()).toHaveLength(2)
})

test("session MCP name conflicts fault the entire named server and settings changes rejudge retained candidates", async () => {
  const boot: RunnerTool[] = [candidate("My Server")[0]]
  const table = new McpSessions(
    () => boot,
    async (input) => ({
      tools: [
        ...candidate("My Server", input.conversation === "first" ? "Read a document" : "Different contract"),
        ...candidate("safe"),
      ],
      issues: [],
      async close() {},
    }),
    async () => {},
  )
  const input = {
    workspace: "workspace",
    conversation: "first",
    directory: "/project",
    signal: owner.signal,
    servers: [{ name: "My Server", command: "peer" }],
  }
  const initial = await table.bind(input)
  expect(initial.tools).toEqual(["mcp__safe__read", "mcp__safe__write"])
  expect(initial.issues).toEqual(["My Server: name taken by the boot table"])
  boot.length = 0
  expect(table.tools()).toHaveLength(4)
  const conflict = await table.bind({ ...input, conversation: "second" })
  expect(conflict.tools).toEqual(["mcp__safe__read", "mcp__safe__write"])
  expect(conflict.issues).toEqual(["My Server: name taken by conversation first"])
  expect(table.tools()).toHaveLength(4)
})
