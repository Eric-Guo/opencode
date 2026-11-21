import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import { T3Catalog } from "../src/t3-catalog"
import { T3Client } from "../src/t3"
import { T3Native } from "../src/t3-native"
import { T3Transport, T3Uncertain } from "../src/t3-transport"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"

const providers = [
  {
    instanceId: "native-codex",
    driver: "codex",
    enabled: true,
    status: "ready",
    models: [
      { slug: "code", name: "Code Model", isDefault: true, aliases: ["Code"] },
      { slug: "fast", name: "Fast Model" },
    ],
  },
]

function service(
  options: {
    version?: number
    bundledHandshake?: boolean
    holdLaunch?: () => void
    loseLaunch?: boolean
    launchReply?: "failure" | "malformed" | "wrong id" | "duplicate handshake"
    corruptModel?: boolean
    oversizedReport?: boolean
    missingMessage?: boolean
    question?: "command" | "user_input"
    unsafe?: boolean
  } = {},
) {
  const requests: { tag: string; payload: JsonObject }[] = []
  const http: { path: string; authorization: string | null; compression: string | null }[] = []
  const state = {
    projection: {
      thread: {
        id: "pending",
        projectId: "project",
        runtimeMode: "approval-required",
        modelSelection: { instanceId: "native-codex", model: "code" },
        branch: "main",
        worktreePath: "/project",
      },
      runs: [
        {
          id: "native-run",
          ordinal: 1,
          status: "completed",
          modelSelection: { instanceId: "native-codex", model: "code" },
        },
      ],
      messages: [] as { id: string; role: string; text: string }[],
      runtimeRequests: [] as JsonObject[],
      nodes: [] as JsonObject[],
      providerSessions: [] as JsonObject[],
      subagents: [],
      turnItems: [{ id: "check", type: "command_execution", input: "bun test", outputOmitted: true }] as JsonObject[],
    },
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url)
      http.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        compression: request.headers.get("sec-websocket-extensions"),
      })
      if (url.pathname === "/api/auth/websocket-ticket") return Response.json({ ticket: "fixture-ticket" })
      if (url.pathname === "/ws" && url.searchParams.get("wsTicket") === "fixture-ticket" && server.upgrade(request))
        return
      return new Response("Unexpected request", { status: 404 })
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(message.toString()) as { _tag: string; id: string; tag: string; payload: JsonObject }
        if (frame._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }))
          return
        }
        requests.push(frame)
        const value = (() => {
          if (frame.tag === "server.getConfig")
            return { environment: { orchestrationProtocolVersion: options.version ?? 2 }, providers }
          if (frame.tag === "orchestration.launchThread") {
            state.projection.thread.id = String(frame.payload.threadId)
            if (!options.missingMessage)
              state.projection.messages.push(
                {
                  id: String((frame.payload.initialMessage as JsonObject).messageId),
                  role: "user",
                  text: "Fix parser",
                },
                {
                  id: "answer",
                  role: "assistant",
                  text: options.oversizedReport ? "界".repeat(24000) : "Implemented and checked",
                },
              )
            if (options.corruptModel) {
              state.projection.runs[0].modelSelection.model = "substituted"
              state.projection.runs[0].status = "running"
            }
            if (options.question) {
              state.projection.runs[0].status = "waiting"
              state.projection.runtimeRequests = [
                {
                  id: "question",
                  nodeId: "approval",
                  kind: options.question,
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId: "session" },
                },
              ]
              state.projection.nodes = [{ id: "approval", parentNodeId: "command" }]
              state.projection.providerSessions = [{ id: "session", status: "waiting", cwd: "/project" }]
              state.projection.turnItems = [
                {
                  type: "approval_request",
                  requestId: "question",
                  prompt: "Choose the action",
                  options: [{ decision: "accept" }, { decision: "decline" }],
                  questions: [
                    {
                      id: "colors",
                      question: "Which colors?",
                      multiSelect: true,
                      allowCustomAnswer: false,
                      options: [
                        { label: "Blue", value: "blue-code" },
                        { label: "Green", value: "green-code" },
                      ],
                    },
                  ],
                },
                {
                  type: "command_execution",
                  nodeId: "command",
                  input: options.unsafe ? "git push --force origin main" : "bun test",
                },
              ]
            }
            return { threadId: frame.payload.threadId, projection: state.projection }
          }
          if (frame.tag === "orchestration.getThreadProjection") return state.projection
          if (frame.tag === "orchestration.getTurnItem")
            return { item: { type: "command_execution", input: "bun test", output: "All checks passed", exitCode: 0 } }
          if (frame.tag === "orchestration.getFullThreadDiff")
            return options.oversizedReport ? {} : { diff: "+verified fixture change\n" }
          if (frame.tag === "orchestration.dispatchCommand" && frame.payload.type === "run.interrupt") {
            state.projection.runs[0].status = "interrupted"
            return { sequence: 1 }
          }
          if (frame.tag === "orchestration.dispatchCommand" && frame.payload.type === "runtime-request.respond") {
            state.projection.runtimeRequests = []
            state.projection.runs[0].status = "completed"
            return { sequence: 2 }
          }
          return { received: frame.payload }
        })()
        if (options.holdLaunch && frame.tag === "orchestration.launchThread") {
          options.holdLaunch()
          return
        }
        if (options.loseLaunch && frame.tag === "orchestration.launchThread") {
          socket.close()
          return
        }
        if (options.launchReply && frame.tag === "orchestration.launchThread") {
          const replies = {
            failure: { _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", cause: "fixture-private" } },
            malformed: "{",
            "wrong id": { _tag: "Exit", requestId: "another", exit: { _tag: "Success" } },
            "duplicate handshake": {
              _tag: "Exit",
              requestId: "0",
              exit: { _tag: "Success", value: { environment: { orchestrationProtocolVersion: 2 } } },
            },
          }
          const reply = replies[options.launchReply]
          socket.send(typeof reply === "string" ? reply : JSON.stringify(reply))
          return
        }
        const reply = { _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }
        socket.send(
          JSON.stringify(
            options.bundledHandshake && frame.id === "0" ? [reply, { ...reply, requestId: "1" }] : [reply],
          ),
        )
      },
    },
  })
  return {
    server,
    http,
    requests,
    state,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("T3 rejects incomplete work controls before opening Nexus storage or a peer connection", async () => {
  using peer = service()
  const store = storeFixture(() => {
    throw new Error("T3 must not read a work record")
  })
  const signal = new AbortController().signal
  const client = new T3Client(
    { url: peer.server.url.origin, token: "bearer", project_id: "project" },
    {
      signal,
      directory: tmpdir(),
      storage: tmpdir(),
      application: () =>
        new NexusApplication(store.client, { workspace: "workspace", agent: "main", runner: "runner" }, () => ({})),
    },
  )

  try {
    const control = client.tools().find((tool) => tool.definition.name === "coding_work")!
    const context = {
      workspace: "workspace",
      conversation: "conversation",
      directory: tmpdir(),
      run: "run",
      task: "task",
      signal,
    }

    for (const action of ["observe", "steer", "stop", "forget"])
      expect(await control.execute({ action }, context)).toMatchObject({
        is_error: true,
        content: expect.stringContaining("work_id is required"),
      })

    expect(await control.execute({ action: "steer", work_id: "work" }, context)).toMatchObject({
      is_error: true,
      content: expect.stringContaining("prompt is required"),
    })
    expect(peer.http).toEqual([])
    expect(peer.requests).toEqual([])
  } finally {
    await client.close()
    store.server.stop(true)
  }
})

const launch = {
  threadId: "thread",
  commandId: "command",
  title: "Task",
  projectId: "project",
  modelSelection: { instanceId: "codex", model: "code" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: { messageId: "one", text: "Check parser", attachments: [] },
}

test("T3 rejects unsupported methods and malformed payloads before ticket discovery", async () => {
  using peer = service()
  const bridge = new T3Transport(peer.server.url.origin, "fixture-bearer")
  const signal = AbortSignal.timeout(2000)
  await expect(bridge.call("other", {}, signal)).rejects.toThrow("method")
  await expect(bridge.call("server.getConfig", [], signal)).rejects.toThrow("payload")
  await expect(bridge.call("orchestration.getThreadProjection", {}, signal)).rejects.toThrow("payload")
  await expect(
    bridge.call("orchestration.launchThread", { ...launch, runtimeMode: "unknown" }, signal),
  ).rejects.toThrow("payload")
  expect(peer.http).toEqual([])
})

test("T3 authenticates every exchange and refuses incompatible protocol before mutations", async () => {
  using peer = service({ version: 1 })
  const bridge = new T3Transport(peer.server.url.origin, "fixture-bearer")
  await expect(bridge.call("orchestration.launchThread", launch, AbortSignal.timeout(2000))).rejects.toThrow(
    "protocol-2",
  )
  expect(peer.requests.map((row) => row.tag)).toEqual(["server.getConfig"])
  expect(peer.http[0].authorization).toBe("Bearer fixture-bearer")
  expect(peer.http[1].compression).toBeNull()
})

test("T3 lost mutation responses remain uncertain without transport retries", async () => {
  using peer = service({ loseLaunch: true })
  const bridge = new T3Transport(peer.server.url.origin, "fixture-bearer")
  await expect(bridge.call("orchestration.launchThread", launch, AbortSignal.timeout(2000))).rejects.toBeInstanceOf(
    T3Uncertain,
  )
  expect(peer.requests.filter((row) => row.tag === "orchestration.launchThread")).toHaveLength(1)
})

test("T3 accepts only a reply received after its business request", async () => {
  using peer = service({ bundledHandshake: true })
  const bridge = new T3Transport(peer.server.url.origin, "fixture-bearer")
  expect(await bridge.call("orchestration.launchThread", launch, AbortSignal.timeout(2000))).toMatchObject({
    threadId: launch.threadId,
  })
})

test("T3 preserves caller cancellation after dispatch", async () => {
  const launched = Promise.withResolvers<void>()
  using peer = service({ holdLaunch: launched.resolve })
  const bridge = new T3Transport(peer.server.url.origin, "fixture-bearer")
  const controller = new AbortController()
  const pending = bridge.call("orchestration.launchThread", launch, controller.signal)
  await launched.promise
  const reason = new Error("Caller stopped the assignment")
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(peer.requests.filter((row) => row.tag === "orchestration.launchThread")).toHaveLength(1)
})

test("T3 catalog resolves explicit aliases without provider or model fallback", () => {
  const catalog = new T3Catalog({
    providers: [
      ...providers,
      {
        instanceId: "native-claude",
        driver: "claudeAgent",
        enabled: true,
        status: "ready",
        models: [{ slug: "review", name: "Review" }],
      },
    ],
  })
  expect(catalog.select("Codex", "Code").model).toBe("code")
  expect(catalog.select("Claude").model).toBe("review")
  expect(catalog.select(" Codex ", " Code ").model).toBe("code")
  expect(catalog.select(" Claude ", " ").model).toBe("review")
  expect(() => catalog.select()).toThrow("Choose one")
  expect(() => catalog.select("Codex", "review")).toThrow("unambiguous")
  expect(JSON.stringify(catalog.report())).not.toContain("native-codex")
})

for (const mode of [
  "normal",
  "lost launch",
  "oversized report",
  "failure",
  "malformed",
  "wrong id",
  "duplicate handshake",
] as const)
  test("T3 result and durable assignment survive replay: " + mode, async () => {
    const oversizedReport = mode === "oversized report"
    using peer = service({
      loseLaunch: mode === "lost launch",
      oversizedReport,
      launchReply: mode === "normal" || mode === "lost launch" || mode === "oversized report" ? undefined : mode,
    })
    const store = storeFixture()
    const directory = await mkdtemp(join(tmpdir(), "nexus-t3-"))
    try {
      const app = new NexusApplication(
        store.client,
        { agent: "agent", runner: "runner", workspace: "workspace" },
        () => ({}),
      )
      const client = new T3Client(
        {
          url: peer.server.url.origin,
          token: "fixture-bearer",
          project_id: "project",
          workspace: { type: "worktree", baseRef: "main", branch: "main", startFromOrigin: true },
        },
        { application: () => app, directory, storage: directory, signal: AbortSignal.timeout(5000) },
      )
      const files: { name: string; text: string }[] = []
      const context = {
        workspace: "workspace",
        conversation: "conversation",
        run: "run",
        task: "delegate",
        directory,
        signal: AbortSignal.timeout(5000),
        ask: async () => "accept",
        publish: async (file: Blob, name: string) => {
          files.push({ name, text: await file.text() })
          return { type: "resource_link", uri: "nexus://uploads/fixture", name }
        },
      }
      const result = await client
        .tools()[0]
        .execute({ prompt: "Fix parser", agent: " Codex ", model: " Code " }, context)
      expect(result.is_error).toBe(false)
      expect(result.structured_content).toMatchObject({
        model: "code",
        branch: "main",
        worktree: "/project",
        requests: [],
      })
      expect(files.map((row) => row.name.split(".").at(-1))).toEqual(oversizedReport ? ["json"] : ["json", "diff"])
      expect(files[0].text).toContain("All checks passed")
      if (oversizedReport) {
        expect(result.structured_content).toHaveProperty(
          "limitation",
          expect.stringContaining("Final diff unavailable"),
        )
        expect(result.content).toMatchObject([
          { type: "text", text: expect.stringContaining("See the attached JSON report") },
          { type: "resource_link" },
        ])
        expect(JSON.parse(files[0].text)).toHaveProperty("text", "界".repeat(24000))
      } else expect(files[1].text).toContain("verified fixture change")
      const replay = await client
        .tools()[0]
        .execute({ prompt: "Fix parser", agent: " Codex ", model: " Code " }, context)
      expect(replay.structured_content).toHaveProperty("model", "code")
      expect(peer.requests.filter((row) => row.tag === "orchestration.launchThread")).toHaveLength(1)
      expect(peer.requests.find((row) => row.tag === "orchestration.launchThread")?.payload.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "main",
        branch: "main",
        startFromOrigin: true,
      })
      expect(store.entries.size).toBe(1)
      expect(JSON.stringify([...store.entries.values()])).not.toContain("fixture-bearer")
      const record = [...store.entries.values()][0]
      expect(record.value).toHaveProperty("placement.worktreePath", "/project")
      expect(record.value).toHaveProperty("selection.model", "code")
      await expect(
        client.tools()[0].execute(
          { prompt: "Follow-up", work_id: record.public_id, model: "fast" },
          {
            ...context,
            task: "follow-up",
          },
        ),
      ).rejects.toThrow("retains its original agent and model")
      expect(peer.requests.filter((row) => row.payload.type === "message.dispatch")).toHaveLength(0)
      await expect(
        client
          .tools()[1]
          .execute({ action: "observe", work_id: record.public_id }, { ...context, conversation: "fork" }),
      ).rejects.toThrow("another conversation")
    } finally {
      store.server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })

test("T3 model substitution stops the original native work and never launches a replacement", async () => {
  using peer = service({ corruptModel: true })
  const store = storeFixture()
  try {
    const app = new NexusApplication(
      store.client,
      { agent: "agent", runner: "runner", workspace: "workspace" },
      () => ({}),
    )
    const client = new T3Client(
      { url: peer.server.url.origin, token: "fixture-bearer", project_id: "project" },
      { application: () => app, directory: "/project", storage: "/protected", signal: AbortSignal.timeout(5000) },
    )
    await expect(
      client.tools()[0].execute(
        { prompt: "Fix parser" },
        {
          workspace: "workspace",
          conversation: "conversation",
          run: "run",
          task: "delegate",
          directory: "/project",
          signal: AbortSignal.timeout(5000),
          ask: async () => "accept",
        },
      ),
    ).rejects.toThrow("model or provider changed")
    expect(peer.requests.filter((row) => row.payload.type === "run.interrupt")).toHaveLength(1)
    expect(peer.requests.filter((row) => row.tag === "orchestration.launchThread")).toHaveLength(1)
  } finally {
    store.server.stop(true)
  }
})

test("T3 local setup preserves existing native provider settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-t3-native-"))
  try {
    const native = new T3Native(directory, directory)
    await native.prepare()
    const path = join(directory, "server", "userdata", "settings.json")
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty(
      "providerInstances.codex.config.homePath",
      join(directory, "codex"),
    )
    await writeFile(path, '{"user":"preserved"}')
    await native.prepare()
    expect(await readFile(path, "utf8")).toBe('{"user":"preserved"}')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const mode of ["approve", "unsafe", "expired", "question"] as const)
  test("T3 native callbacks preserve one-shot decisions and original identity: " + mode, async () => {
    using peer = service({ question: mode === "question" ? "user_input" : "command", unsafe: mode === "unsafe" })
    const store = storeFixture()
    try {
      const app = new NexusApplication(
        store.client,
        { agent: "agent", runner: "runner", workspace: "workspace" },
        () => ({}),
      )
      const client = new T3Client(
        { url: peer.server.url.origin, token: "fixture-bearer", project_id: "project" },
        {
          application: () => app,
          directory: "/project",
          storage: "/private-runtime",
          signal: AbortSignal.timeout(2000),
        },
      )
      const questions: string[] = []
      const result = client.tools()[0].execute(
        { prompt: "Fix parser" },
        {
          workspace: "workspace",
          conversation: "conversation",
          run: "run",
          task: "delegate",
          directory: "/project",
          signal: AbortSignal.timeout(2000),
          ask: async (key) => {
            questions.push(key)
            if (mode === "question") {
              const work = [...store.entries.values()][0]
              const observation = await client.tools()[1].execute(
                { action: "observe", work_id: work.public_id },
                {
                  workspace: "workspace",
                  conversation: "conversation",
                  run: "run",
                  task: "observe",
                  directory: "/project",
                  signal: AbortSignal.timeout(2000),
                },
              )
              expect(observation.structured_content).toMatchObject({
                requests: [
                  {
                    kind: "user_input",
                    prompt: "Choose the action",
                    questions: [{ prompt: "Which colors?", options: ["Blue", "Green"] }],
                  },
                ],
              })
            }
            if (mode === "expired") peer.state.projection.providerSessions[0].status = "stopped"
            return mode === "question" ? '["Blue","Green"]' : "accept"
          },
        },
      )
      if (mode === "expired") await expect(result).rejects.toThrow("expired")
      else await result
      const responses = peer.requests.filter((row) => row.payload.type === "runtime-request.respond")
      expect(responses).toHaveLength(mode === "expired" ? 0 : 1)
      expect(questions).toHaveLength(mode === "unsafe" ? 0 : 1)
      if (mode === "approve" || mode === "unsafe")
        expect(responses[0].payload).toMatchObject({
          requestId: "question",
          decision: mode === "unsafe" ? "decline" : "accept",
        })
      if (mode === "question") expect(responses[0].payload.answers).toEqual({ colors: ["blue-code", "green-code"] })
      if (questions.length) expect(questions[0]).toMatch(/^t3_[a-f0-9]{32}$/)
    } finally {
      store.server.stop(true)
    }
  })

test("T3 refuses to adopt or stop another service already using its configured port", async () => {
  using peer = service()
  const directory = await mkdtemp(join(tmpdir(), "nexus-t3-port-"))
  try {
    const native = new T3Native(directory, directory)
    await expect(native.start(peer.server.port!, AbortSignal.timeout(2000))).rejects.toThrow("already in use")
    await native.close()
    expect((await fetch(new URL("/api/auth/websocket-ticket", peer.server.url))).status).toBe(200)
    expect(native.running()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("project setup validates locally, reconciles a lost creation response and adopts the same directory", async () => {
  const projects: { id: string; title: string; workspaceRoot: string }[] = []
  const requests: string[] = []
  const selections: unknown[] = []
  using peer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(request.method + " " + new URL(request.url).pathname)
      if (request.method === "GET") return Response.json({ projects })
      const input = (await request.json()) as { projectId: string; title: string; workspaceRoot: string }
      projects.push({ id: input.projectId, title: input.title, workspaceRoot: input.workspaceRoot })
      return new Response("{")
    },
  })
  const client = new T3Client(
    { url: peer.url.origin, token: "bearer" },
    {
      signal: new AbortController().signal,
      storage: tmpdir(),
      directory: tmpdir(),
      application() {
        throw new Error("Unexpected Nexus request")
      },
      configure: async (changes) => {
        selections.push(changes)
      },
    },
  )
  for (const path of [" ", " relative "])
    await expect(client.command({ action: "t3.create", path })).rejects.toThrow("absolute path")
  expect(requests).toEqual([])
  expect(selections).toEqual([])
  const created = await client.command({ action: "t3.create", path: " /work/project " })
  expect(created).toEqual(projects[0])
  expect(created).toMatchObject({ workspaceRoot: "/work/project", title: "project" })
  expect(await client.command({ action: "t3.create", path: "/work/project" })).toEqual(created)
  expect(requests).toEqual(["GET /api/projects", "POST /api/projects/mutate", "GET /api/projects", "GET /api/projects"])
  expect(selections).toEqual(Array(2).fill([{ op: "set", path: ["project_id"], value: projects[0].id }]))
})
