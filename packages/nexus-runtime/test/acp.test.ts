import { expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { AcpClient } from "../src/acp"
import { ClaimDeadline } from "../src/claim-control"
import { acpFixture, eventually } from "./fixture/acp"
import { acpSettings, acpEnvironment } from "../src/acp-settings"
import { builtinExtensions } from "../src/builtins"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"

const sessionID = Schema.decodeUnknownSync(Schema.Struct({ session: Schema.String }))
const sessions = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      pid: Schema.NullOr(Schema.Number),
      cwd: Schema.String,
      busy: Schema.Boolean,
      calls: Schema.Number,
    }),
  ),
)

test("ACP settings isolate row faults, expand secrets once and keep legacy rows compatible", () => {
  const settings = acpSettings(
    {
      good: { command: "peer", description: "Coding peer", env: { VALUE: "${PARENT}", API_KEY: "literal" } },
      missing: { command: "peer", description: "Unavailable variable", env: { VALUE: "${UNSET}" } },
      invalid: { command: "peer", description: "Bad timeout", timeout_ms: 0 },
      whitespace: { command: "peer", description: "Blank model", model: " " },
      legacy: ["peer", "--stdio"],
      disabled: { command: "absent", description: "Disabled peer", enabled: false },
    },
    { PARENT: "${NESTED}", NESTED: "must-not-expand" },
  )
  expect(settings.agents.map((agent) => agent.name)).toEqual(["good", "legacy", "disabled"])
  expect(settings.faults.map((row) => row.name)).toEqual(["missing", "invalid", "whitespace"])
  expect(settings.agents[0].env.VALUE).toBe("${NESTED}")
  expect(settings.agents[0].secrets).toEqual(["${NESTED}", "literal"])
  expect(settings.agents[1]).toMatchObject({ command: "peer", args: ["--stdio"], permissions: "ask" })
  expect(acpEnvironment(settings.agents[0])).toMatchObject({ VALUE: "${NESTED}", API_KEY: "literal" })
  expect(acpEnvironment(settings.agents[0])).not.toHaveProperty("OPENCODE_NEXUS_ACP_AGENTS")
  expect(() => acpSettings({ "Invalid Name": {} })).toThrow("names")
})

test("ACP configuration migrates legacy rows, redacts credentials and activates healthy siblings without spawning", async () => {
  const fixture = await acpFixture()
  const module = (await builtinExtensions(undefined, fixture.storage)).find(
    (module) => module.descriptor.id === "nexus.acp-client",
  )!
  const configuration = new Configuration(fixture.storage + "/settings.json")
  await configuration.change(
    { ...module.descriptor, configuration_version: 1 },
    {
      id: module.descriptor.id,
      enabled: true,
      operations: [
        {
          op: "set",
          path: ["agents"],
          value: {
            peer: fixture.row({ env: { API_KEY: "private-test-token" } }),
            legacy: [process.execPath, fixture.peer],
            broken: { command: 42, description: "Invalid command" },
            disabled: { command: "/missing-executable", description: "Disabled", enabled: false },
          },
        },
      ],
    },
  )
  const manager = new ExtensionManager(
    configuration,
    [module],
    fixture.work,
    new AbortController().signal,
    async () => {},
  )
  try {
    await manager.start()
    expect(fixture.events).toEqual([])
    expect(manager.tools().map((tool) => tool.definition.name)).toEqual(["delegate_agent"])
    expect(manager.list()[0]).toMatchObject({ active: true, ready: false })
    expect(JSON.stringify(manager.list())).not.toContain("private-test-token")
    expect(manager.list()[0].configuration).toMatchObject({ agents: { peer: { env: "[saved]" } } })
    expect(await manager.command("acp.list", { action: "acp.list" })).toMatchObject({
      agents: [{ name: "peer" }, { name: "legacy" }, { name: "disabled" }],
      faults: [{ name: "broken" }],
    })
    expect(await manager.command("acp.sessions", { action: "acp.sessions" })).toEqual([])
    await expect(manager.command("not.loaded", {})).rejects.toThrow("not loaded")
    const invalid = new AcpClient({ directory: fixture.row({ command: fixture.work }) })
    await expect(invalid.check()).rejects.toThrow("executable not found")
    await invalid.close()
  } finally {
    await manager.close()
    await fixture.close()
  }
})

test("terminal authentication is reported without invoking an interactive login", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient(
    { peer: fixture.row({ env: { AUTH_REQUIRED: "1", TERMINAL_AUTH: "1" }, auth_method: "terminal-login" }) },
    { storage: fixture.storage },
  )
  try {
    const result = await client.tool()!.execute({ agent: "peer", prompt: "first" }, fixture.context())
    expect(result.is_error).toBe(true)
    expect(result.content).toContain("acp_auth_required")
    expect(result.content).toContain("terminal-login (terminal)")
    expect(fixture.events.some((event) => event.event === "authenticate")).toBe(false)
    expect(await client.command({ action: "acp.sessions" })).toEqual([])
  } finally {
    await client.close()
    await fixture.close()
  }
})

test("ACP sessions reuse one child, authenticate once, select a model, and retain birth placement", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient(
    { peer: fixture.row({ env: { AUTH_REQUIRED: "1" }, model: "picked" }) },
    { storage: fixture.storage, directory: fixture.work },
  )
  const tool = client.tool()!
  try {
    await client.check()
    expect(fixture.events).toHaveLength(0)
    const first = await tool.execute({ agent: "peer", prompt: "first" }, fixture.context())
    expect(first.is_error).toBe(false)
    const id = sessionID(first.structured_content).session
    const initial = sessions(await client.command({ action: "acp.sessions" }))[0]
    expect(String(first.content)).toContain('"model":"picked"')
    const second = await tool.execute(
      { agent: "peer", prompt: "second", session: id },
      fixture.context({ directory: fixture.root }),
    )
    expect(second.is_error).toBe(false)
    expect(sessionID(second.structured_content).session).toBe(id)
    expect(String(second.content)).toContain(fixture.work)
    expect(fixture.events.filter((event) => event.event === "initialize")).toHaveLength(1)
    expect(fixture.events.filter((event) => event.event === "authenticate")).toHaveLength(1)
    expect(fixture.events.filter((event) => event.event === "model")).toHaveLength(1)
    expect(
      fixture.events.filter((event) => event.event === "new").every((event) => JSON.stringify(event.mcp) === "[]"),
    ).toBe(true)
    await expect(
      tool.execute({ agent: "peer", prompt: "foreign", session: id }, fixture.context({ conversation: "other" })),
    ).rejects.toThrow("owned")
    await mkdir(fixture.work + "/nested")
    const moved = await tool.execute(
      { agent: "peer", prompt: "move", session: id, workdir: "nested" },
      fixture.context(),
    )
    expect(moved.is_error).toBe(true)
    expect(moved.content).toContain("fixed")
    const opened = await tool.execute({ agent: "peer", prompt: "new", workdir: "nested" }, fixture.context())
    expect(opened.is_error).toBe(false)
    const current = sessions(await client.command({ action: "acp.sessions" }))
    expect(current).toHaveLength(2)
    expect(current.every((row) => row.pid === initial.pid)).toBe(true)
    expect(current[1].cwd).toBe(fixture.work + "/nested")
    const probe = await client.command({ action: "acp.probe", agent: "peer" })
    expect(probe).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "Fixture" },
      authMethods: [{ id: "login", type: "agent" }],
    })
    expect(sessions(await client.command({ action: "acp.sessions" }))).toHaveLength(2)
    await client.command({ action: "acp.kill", session: id })
    expect(sessions(await client.command({ action: "acp.sessions" }))).toEqual([])
    expect(await client.command({ action: "acp.logs", session: id })).toContain("session/set_config_option")
    await expect(tool.execute({ agent: "peer", prompt: "old", session: id }, fixture.context())).rejects.toThrow(
      "ended",
    )
  } finally {
    await client.close()
    await fixture.close()
  }
}, 15000) // A resident child and an independent real SDK probe exercise authentication and session configuration.

test("ACP permission decisions use tracked calls and the shared floor, never standing grants or editor filesystem access", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient(
    { peer: fixture.row({ env: { PROTECTED_PATH: fixture.storage + "/credential" } }) },
    { storage: fixture.storage + "/acp", protectedRoots: [fixture.storage] },
  )
  try {
    const result = await client.tool()!.execute({ agent: "peer", prompt: "permissions" }, fixture.context())
    expect(result.is_error).toBe(false)
    expect(result.content).toContain("no,no,once decline -32601")
    expect(result.structured_content).toMatchObject({ calls: 3, refused: 2 })
    expect(result.content).toContain("Which branch?")
    const id = sessionID(result.structured_content).session
    const log = await client.command({ action: "acp.logs", session: id })
    expect(log).toContain('"floor_refused":true')
    expect(log).toContain('"optionId":"once"')
    expect(log).not.toContain('"optionId":"always"}')
  } finally {
    await client.close()
    await fixture.close()
  }
})

test("canceled prompts remain quarantined until their response and late updates cannot enter a continuation", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient({ peer: fixture.row() }, { storage: fixture.storage })
  const owner = new AbortController()
  const tool = client.tool()!
  try {
    const first = await tool.execute({ agent: "peer", prompt: "first" }, fixture.context())
    const id = sessionID(first.structured_content).session
    const initial = sessions(await client.command({ action: "acp.sessions" }))[0]
    const pending = tool.execute(
      { agent: "peer", prompt: "cancelme", session: id },
      fixture.context({ signal: owner.signal }),
    )
    void pending.catch(() => {})
    const prompting = await fixture.wait("prompt", (event) => event.prompt === "cancelme")
    owner.abort(new Error("stop delegated task"))
    await expect(pending).rejects.toThrow("stop delegated task")
    await fixture.wait("cancel")
    const blocked = await tool.execute({ agent: "peer", prompt: "too early", session: id }, fixture.context())
    expect(blocked.is_error).toBe(true)
    expect(blocked.content).toContain("still finishing")
    fixture.release("late-" + prompting.pid + "-" + prompting.session)
    await eventually(async () => !sessions(await client.command({ action: "acp.sessions" }))[0].busy)
    const followed = await tool.execute({ agent: "peer", prompt: "follow-up", session: id }, fixture.context())
    expect(followed.is_error).toBe(false)
    expect(String(followed.content)).toContain("follow-up")
    expect(String(followed.content)).not.toContain("late output")
    expect(sessions(await client.command({ action: "acp.sessions" }))[0].pid).toBe(initial.pid)
    expect(await client.command({ action: "acp.logs", session: id })).toContain("late output")
  } finally {
    fixture.release("unused")
    await client.close()
    await fixture.close()
  }
})

test("a queued deadline cannot terminate another prompt's child or open a late session", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient({ peer: fixture.row() }, { storage: fixture.storage })
  const deadline = new AbortController()
  try {
    const active = client.tool()!.execute({ agent: "peer", prompt: "cancelme" }, fixture.context())
    const started = await fixture.wait("prompt")
    const queued = client
      .tool()!
      .execute({ agent: "peer", prompt: "queued" }, fixture.context({ signal: deadline.signal }))
    deadline.abort(new ClaimDeadline("queued deadline"))
    expect((await queued).structured_content).toMatchObject({ stopReason: "timed_out" })
    expect(sessions(await client.command({ action: "acp.sessions" }))).toMatchObject([{ pid: started.pid, busy: true }])
    fixture.release("late-" + started.pid + "-" + started.session)
    await active
    expect(sessions(await client.command({ action: "acp.sessions" }))).toHaveLength(1)
    expect(fixture.events.filter((event) => event.event === "prompt")).toHaveLength(1)
    expect(fixture.events.filter((event) => event.event === "new")).toHaveLength(1)
  } finally {
    await client.close()
    await fixture.close()
  }
})

test("a delegated execution deadline terminates its child and sessions", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient({ peer: fixture.row() }, { storage: fixture.storage })
  const owner = new AbortController()
  try {
    const first = await client.tool()!.execute({ agent: "peer", prompt: "first" }, fixture.context())
    const id = sessionID(first.structured_content).session
    const pending = client
      .tool()!
      .execute({ agent: "peer", prompt: "deadline", session: id }, fixture.context({ signal: owner.signal }))
    await fixture.wait("prompt", (event) => event.prompt === "deadline")
    owner.abort(new ClaimDeadline("fixture deadline"))
    const result = await pending
    expect(result.is_error).toBe(true)
    expect(result.structured_content).toMatchObject({ stopReason: "timed_out" })
    expect(sessions(await client.command({ action: "acp.sessions" }))).toEqual([])
    await expect(
      client.tool()!.execute({ agent: "peer", prompt: "stale", session: id }, fixture.context()),
    ).rejects.toThrow("ended")
    const fresh = await client.tool()!.execute({ agent: "peer", prompt: "fresh" }, fixture.context())
    expect(fresh.is_error).toBe(false)
    expect(sessionID(fresh.structured_content).session).not.toBe(id)
  } finally {
    await client.close()
    await fixture.close()
  }
})

test("canceling while an approval is pending cannot grant a delayed allow-once answer", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient({ peer: fixture.row({ permissions: "ask" }) }, { storage: fixture.storage })
  const owner = new AbortController()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<string>()
  try {
    const pending = client.tool()!.execute(
      { agent: "peer", prompt: "waiting-permission" },
      fixture.context({
        signal: owner.signal,
        ask: async () => {
          asked.resolve()
          return answer.promise
        },
      }),
    )
    void pending.catch(() => {})
    await asked.promise
    owner.abort(new Error("cancel while waiting"))
    await expect(pending).rejects.toThrow("cancel while waiting")
    answer.resolve("Allow once")
    expect(await fixture.wait("permission-result")).toMatchObject({ outcome: { outcome: "cancelled" } })
  } finally {
    answer.resolve("Deny")
    await client.close()
    await fixture.close()
  }
})

test("releasing a child during initialization cannot publish a late session or retire its replacement", async () => {
  const fixture = await acpFixture()
  const client = new AcpClient({ peer: fixture.row({ env: { STARTUP_GATE: "1" } }) }, { storage: fixture.storage })
  try {
    const opening = client.tool()!.execute({ agent: "peer", prompt: "old" }, fixture.context())
    const first = await fixture.wait("initialize")
    await client.command({ action: "acp.release", workspace: "workspace", conversation: "conversation" })
    expect((await opening).is_error).toBe(true)
    const replacement = client.tool()!.execute({ agent: "peer", prompt: "new" }, fixture.context())
    const next = await fixture.wait("initialize", (event) => event.pid !== first.pid)
    fixture.release("startup-" + next.pid)
    const result = await replacement
    expect(result.is_error).toBe(false)
    fixture.release("startup-" + first.pid)
    expect(sessions(await client.command({ action: "acp.sessions" }))).toHaveLength(1)
    expect(sessions(await client.command({ action: "acp.sessions" }))[0]).toMatchObject({ pid: next.pid })
  } finally {
    await client.close()
    await fixture.close()
  }
})

test("configured secrets are redacted from replies and JSONL capture snapshots", async () => {
  const fixture = await acpFixture()
  const secret = 'fixture-"credential"\\value\nsecond line'
  const client = new AcpClient(
    { peer: fixture.row({ env: { CREDENTIAL_TOKEN: secret } }) },
    { storage: fixture.storage },
  )
  const published: string[] = []
  try {
    const result = await client.tool()!.execute(
      { agent: "peer", prompt: "secret" },
      fixture.context({
        publish: async (blob, name) => {
          published.push(await blob.text())
          return { type: "resource_link", uri: "nexus://uploads/transcript", name }
        },
      }),
    )
    expect(result.is_error).toBe(false)
    expect(JSON.stringify(result)).not.toContain("second line")
    expect(JSON.stringify(result)).toContain("[redacted]")
    expect(published).toHaveLength(1)
    const frames = published[0]
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(JSON.stringify(frames)).not.toContain("second line")
    expect(
      frames.some((frame) => frame.direction === "in" && JSON.stringify(frame.message).includes("[redacted]")),
    ).toBe(true)
    expect(result.content).toMatchObject([
      { type: "text" },
      { type: "resource_link", uri: "nexus://uploads/transcript" },
    ])
  } finally {
    await client.close()
    await fixture.close()
  }
})
