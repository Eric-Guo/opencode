import { expect, test } from "bun:test"
import { Toolsets, type CredentialDocument, type Workspace, type JsonObject } from "@cybros/agent"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NexusRuntime } from "../src/runtime"
import { atomic } from "../src/storage"
import { Schema } from "effect"
import { conversationFixture } from "./fixture/conversation"

const Declaration = Schema.Struct({
  configuration: Schema.Struct({
    kernel_tools: Schema.Array(Schema.String),
    image_model: Schema.NullOr(Schema.String),
    compaction_policy: Schema.Struct({ mode: Schema.String }),
  }),
  prompt_documents: Schema.optional(Schema.Struct({ summarizer: Schema.Struct({ content: Schema.String }) })),
})

test.each([
  { name: "another agent's dedicated", dedicated: true, owned: false, create: false },
  { name: "another agent's archived dedicated", dedicated: true, owned: false, create: false, state: "archived" },
  { name: "this agent's dedicated", dedicated: true, owned: true, create: false },
  { name: "non-dedicated", dedicated: false, owned: false, create: false },
  { name: "automatically created", dedicated: true, owned: true, create: true },
  { name: "restored API key", dedicated: false, owned: false, create: false, apiKey: true },
  { name: "imported API key", dedicated: false, owned: false, create: false, importKeys: true },
])("validates $name workspace before reporting ready", async (fixture) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-runtime-")))
  const storage = join(directory, "storage")
  const project = join(directory, "project")
  await Promise.all([mkdir(storage), mkdir(project)])
  const runtime = new NexusRuntime(storage)
  const changed = Promise.withResolvers<typeof Declaration.Type>()
  const calls: { path: string; method: string; authorization: string | null; after: string | null; state: string }[] =
    []
  const approval = {
    workspace: "workspace",
    conversation: "conversation",
    agent: "agent",
    archived: false,
    refuseDeclaration: false,
    tool: "web_fetch",
    alias: null as string | null,
    input: { url: "HTTPS://Example.com:00443/guide" } as JsonObject,
    target: { kind: "builtin" } as JsonObject,
  }
  const task = () => ({
    key: "call",
    kind: "tool_task",
    status: "needs_approval",
    lifetime: "foreground",
    wake: "immediate",
    after: [],
    waiting_on: [],
    tool_name: approval.tool,
    tool_alias: approval.alias,
    tool_input: approval.input,
    target: approval.target,
  })
  const measured = new Date().toISOString()
  const preset = {
    public_id: "presets",
    namespace: "opencode.presets",
    key: "catalog",
    lock_version: 0,
    created_at: measured,
    updated_at: measured,
    value: {
      presets: [{ public_id: "main-preset", name: "Main", description: "Main", role: null, configuration: {} }],
      main_preset_public_id: "main-preset",
      default_bot_preset_public_id: "main-preset",
    },
  }
  const workspace: Workspace = {
    public_id: "workspace",
    name: "Workspace",
    access_mode: "private",
    state: fixture.state ?? "active",
    dedicated: fixture.dedicated,
    lock_version: 0,
    archived_at: null,
    created_at: measured,
    updated_at: measured,
    metadata: {},
    tool_provider_overrides: {},
    owner: { public_id: "human", display_name: "Human" },
    creator: { public_id: "original-agent", display_name: "Original agent", kind: "agent" },
  }
  using nexus = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      calls.push({
        path,
        method: request.method,
        authorization: request.headers.get("authorization"),
        after: url.searchParams.get("after"),
        state: runtime.status().state,
      })

      if (path === "/oauth/revoke") return new Response(null, { status: 200 })
      if (path === "/agent_api/v1/profile") {
        if (request.headers.get("authorization") === "Bearer invalid")
          return Response.json({ error: { code: "invalid_token" } }, { status: 401 })
        return Response.json({
          member: {
            public_id: request.headers.get("authorization") === "Bearer human" ? "human" : "agent",
            handle: "opencode",
            kind: request.headers.get("authorization") === "Bearer human" ? "human" : "agent",
            role: "member",
          },
          credential: { plane: "member", expires_at: null },
          measured_at: measured,
        })
      }
      if (path === "/agent_api/v1/executor" || path === "/agent_api/v1/executor/announcement")
        return Response.json({
          executor: {
            public_id: "runner",
            kind: "agent",
            status: "active",
            credential_epoch: 0,
            presence: "online",
            agent_public_id: "agent",
            service_roles: ["agent", "runner"],
          },
          measured_at: measured,
        })

      if (path === "/agent_api/v1/workspaces/workspace") return Response.json({ workspace })
      if (path === "/agent_api/v1/workspaces" && request.method === "POST")
        return Response.json({ workspace }, { status: 201 })
      if (path === "/agent_api/v1/workspaces") {
        if (runtime.status().state === "ready")
          return Response.json({ workspaces: [], pagination: { next_after: null } })

        expect(url.searchParams.get("dedicated_to_current_agent")).toBe("true")
        expect(url.searchParams.get("state")).toBe(fixture.state ?? null)

        // The matching workspace can be on a later page, and the creator's ID is not the dedication rule.
        return Response.json({
          workspaces: url.searchParams.has("after")
            ? fixture.owned
              ? [workspace]
              : []
            : [{ ...workspace, public_id: "other-workspace" }],
          pagination: { next_after: url.searchParams.has("after") ? null : "next-page" },
        })
      }
      if (path === "/agent_api/v1/tools/assembly") {
        const body = (await request.json()) as JsonObject
        expect(body.configuration).toBeDefined()
        expect(body.conversation_public_id).toBeUndefined()
        expect(body.default_runner_executor_public_id).toBeNull()
        return Response.json({ tool_definitions: [], environment: {} })
      }
      if (path === "/agent_api/v1/tools")
        return Response.json({
          tools: Toolsets.names("images", "schedules").map((canonical_name) => ({
            canonical_name,
            name: canonical_name,
            effect_profile: {},
            definition: {},
          })),
        })
      if (path === "/agent_api/v1/profile/store_entries")
        return Response.json({ store_entries: [preset], pagination: { next_after: null } })
      if (path === "/agent_api/v1/profile/store_entries/presets") return Response.json({ store_entry: preset })
      if (path.endsWith("/store_entries")) return Response.json({ store_entries: [], pagination: { next_after: null } })
      if (path === "/agent_api/v1/mcp_connections")
        return Response.json({ mcp_connections: [], pagination: { next_after: null } })
      if (path === "/agent_api/v1/executors") return Response.json({ executors: [] })
      if (path.endsWith("/conversations/conversation"))
        return Response.json({
          conversation: conversationFixture({
            workspace_public_id: approval.workspace,
            answering_user_public_id: approval.agent,
            archived_at: approval.archived ? measured : null,
          }),
        })
      if (path.endsWith("/runs/run"))
        return Response.json({
          run: {
            public_id: "run",
            status: "needs_attention",
            turn: { conversation_public_id: approval.conversation, status: "running" },
            tasks: [task()],
          },
        })
      if (path.endsWith("/tasks/call")) return Response.json({ task: task() })
      if (path.endsWith("/tasks/call/approve")) return Response.json({ task: { ...task(), status: "completed" } })
      if (path === "/agent_api/v1/profile/configuration") {
        if (approval.refuseDeclaration)
          return Response.json(
            { error: { code: "invalid_configuration", message: "Fixture refused declaration" } },
            { status: 400 },
          )
        const payload = Schema.decodeUnknownSync(Declaration)(await request.json())
        if (
          payload.configuration?.image_model === "image-fixture" &&
          payload.configuration?.compaction_policy?.mode === "off" &&
          !payload.configuration.kernel_tools.some((name: string) => Toolsets.names("schedules").includes(name))
        )
          changed.resolve(payload)
        return Response.json({
          member: {
            public_id: "agent",
            handle: "opencode",
            kind: "agent",
            role: "member",
            display_name: "OpenCode",
            agent_identifier: "opencode.fixture",
          },
          credential: { plane: "member", expires_at: null },
          configuration: null,
          measured_at: measured,
        })
      }
      if (path === "/agent_api/v1/executor/inbox") return Response.json({ tasks: [], pagination: { next_after: null } })

      return new Response(null, { status: 404 })
    },
  })
  try {
    await atomic(join(storage, "settings.json"), {
      origin: nexus.url.origin,
      identifier: "opencode.fixture",
      directory: project,
      workspace: fixture.create ? "" : "workspace",
      model: "provider/model",
    })
    const credentials: CredentialDocument =
      "apiKey" in fixture
        ? {
            version: 2,
            authentication_kind: "api_key",
            connection: "fixture",
            access_token: "fixture-member",
            executor_access_token: "fixture-executor",
          }
        : {
            version: 2,
            authentication_kind: "oauth",
            connection: "fixture",
            rotation: 0,
            refresh_token: "fixture-refresh",
            access_token: "fixture-member",
            executor_access_token: "fixture-executor",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }
    await atomic(join(storage, "agent.json"), credentials)
    if ("importKeys" in fixture) {
      await expect(
        runtime.manage({
          action: "connection.import",
          origin: nexus.url.origin,
          model: "provider/model",
          directory: project,
          workspace: "workspace",
          access_token: "invalid",
          executor_access_token: "fixture-executor",
        }),
      ).rejects.toThrow()
      expect(await Bun.file(join(storage, "agent.json")).json()).toEqual(credentials)
      await runtime.manage({
        action: "connection.import",
        origin: nexus.url.origin,
        model: "provider/model",
        directory: project,
        workspace: "workspace",
        access_token: "fixture-member",
        executor_access_token: "fixture-executor",
      })
    }
    if (!("importKeys" in fixture)) await runtime.restore()

    const deadline = Date.now() + 3000
    while (runtime.status().state === "connecting" && Date.now() < deadline) await Bun.sleep(1)

    const ready = !fixture.dedicated || fixture.owned
    if (ready) expect(runtime.status().error).toBeUndefined()
    expect(runtime.status().state).toBe(ready ? "ready" : "error")
    if (ready) {
      expect(runtime.status().identity).toMatchObject({ agent: "agent", workspace: "workspace" })
      expect(runtime.status().error).toBeUndefined()
      expect(await runtime.policy("workspace", "conversation")).toMatchObject({ tools: [], runner: null })
      expect(runtime.status().executor).toMatchObject({
        running: true,
        claimed: 0,
        nudged: 0,
        canceled: 0,
        in_flight: 0,
        starting: 0,
      })
      if ("apiKey" in fixture) {
        const command = {
          action: "application.approve",
          workspace: "workspace",
          conversation: "conversation",
          run: "run",
          task: "call",
          always: true,
        } as const
        await expect(runtime.manage(command)).rejects.toThrow("Human member token")
        await expect(runtime.manage(command, "https://other.example", "human")).rejects.toThrow("paired Nexus origin")
        await expect(runtime.manage({ ...command, workspace: "other" }, nexus.url.origin, "human")).rejects.toThrow(
          "workspace",
        )
        await expect(runtime.manage(command, nexus.url.origin, "fixture-member")).rejects.toThrow("Human member token")
        approval.conversation = "other"
        await expect(runtime.manage(command, nexus.url.origin, "human")).rejects.toThrow("does not belong")
        approval.conversation = "conversation"
        approval.agent = "other"
        await expect(runtime.manage(command, nexus.url.origin, "human")).rejects.toThrow("does not belong")
        approval.agent = "agent"
        approval.archived = true
        await expect(runtime.manage(command, nexus.url.origin, "human")).rejects.toThrow("does not belong")
        approval.archived = false
        expect(calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(0)
        for (const row of [
          {
            tool: "web_fetch",
            input: { url: "HTTPS://Example.com:00443/guide" },
            target: { kind: "builtin" },
            rule: { tool: "web_fetch", path: "url", match: "HTTPS://Example.com:00443/*", verdict: "allow" },
          },
          {
            tool: "bash",
            input: { command: "bun test" },
            target: { kind: "builtin" },
            rule: { tool: "bash", path: "command", match: "bun test", verdict: "allow" },
          },
          {
            tool: "write",
            input: { path: "/project/result.txt" },
            target: { kind: "builtin" },
            rule: { tool: "write", path: "path", match: "/project/result.txt", verdict: "allow" },
          },
          {
            tool: "web_fetch",
            input: { url: "https://remote.example/" },
            target: { kind: "mcp" },
            alias: "remote_docs",
            rule: { tool: "remote_docs", verdict: "allow" },
          },
        ]) {
          Object.assign(approval, row)
          expect(await runtime.manage(command, nexus.url.origin, "human")).toMatchObject({
            grant: { rule: row.rule, conversation: "conversation" },
          })
        }
        expect(calls.filter((call) => call.path.endsWith("/approve")).map((call) => call.authorization)).toEqual(
          Array(4).fill("Bearer human"),
        )
        approval.agent = "other"
        expect(await runtime.modes("workspace", "conversation")).toMatchObject({
          available: false,
          code_mode_available: false,
        })
        expect(await runtime.manage({ ...command, always: false }, nexus.url.origin, "human")).toMatchObject({
          status: "completed",
        })
        approval.agent = "agent"
        approval.alias = null
        approval.tool = "bash"
        approval.target = { kind: "builtin" }
        approval.input = { command: "bun run build" }
        approval.refuseDeclaration = true
        expect(await runtime.manage(command, nexus.url.origin, "human")).toMatchObject({
          task: { status: "completed" },
          grant: { refused: expect.any(String) },
        })
        approval.refuseDeclaration = false
        expect(await runtime.manage({ ...command, always: false }, nexus.url.origin, "human")).toMatchObject({
          status: "completed",
        })
        approval.workspace = "second-workspace"
        expect(
          await runtime.manage({ ...command, workspace: approval.workspace, always: false }, nexus.url.origin, "human"),
        ).toMatchObject({ status: "completed" })
        expect(calls.filter((call) => call.path.endsWith("/approve")).at(-1)?.path).toBe(
          "/agent_api/v1/workspaces/second-workspace/runs/run/tasks/call/approve",
        )
      }
      if (fixture.owned && !fixture.create) {
        await runtime.configureExtension({
          id: "nexus.images",
          operations: [{ op: "set", path: ["model"], value: "image-fixture" }],
        })
        await runtime.configureExtension({ id: "nexus.compaction", enabled: false })
        await runtime.configureExtension({ id: "nexus.schedules", enabled: false })
        const declaration = await changed.promise
        expect(declaration.configuration).toMatchObject({
          image_model: "image-fixture",
          compaction_policy: { mode: "off" },
        })
        expect(declaration.configuration.kernel_tools).toEqual(Toolsets.names("images"))
        expect(declaration.prompt_documents?.summarizer.content).toContain("Goal:")
        expect(declaration.prompt_documents?.summarizer.content).toContain("Open:")
      }
    } else {
      expect(runtime.status().identity).toBeUndefined()
      expect(runtime.status().error).toBe(
        'Nexus workspace "Workspace" is dedicated to another agent. Disconnect and pair OpenCode with a different workspace, or leave Workspace ID blank to create one.',
      )
      expect(calls.some((call) => call.path === "/agent_api/v1/profile/configuration")).toBe(false)
      expect(calls.some((call) => call.path === "/agent_api/v1/executor/inbox")).toBe(false)
      expect(() => runtime.runners()).toThrow("Nexus is disconnected.")
    }

    if ("apiKey" in fixture || "importKeys" in fixture) {
      expect((await Bun.file(join(storage, "agent.json")).json()).authentication_kind).toBe("api_key")
      await runtime.disconnect()
      expect(await Bun.file(join(storage, "agent.json")).exists()).toBe(false)
      expect(calls.filter((call) => call.path === "/oauth/revoke")).toHaveLength(2)
    }
    expect(
      calls.filter(
        (call) => call.path === "/agent_api/v1/workspaces" && call.method === "GET" && call.state === "connecting",
      ),
    ).toEqual(
      fixture.dedicated
        ? [null, "next-page"].map((after) => ({
            path: "/agent_api/v1/workspaces",
            method: "GET",
            authorization: "Bearer fixture-member",
            after,
            state: "connecting",
          }))
        : [],
    )
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
