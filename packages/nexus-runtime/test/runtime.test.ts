import { expect, test } from "bun:test"
import { Toolsets, type CredentialDocument, type Workspace, type JsonObject } from "@cybros/agent"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NexusRuntime } from "../src/runtime"
import { executorFixture } from "./fixture/executor"
import { atomic } from "../src/storage"
import { Schema } from "effect"
import { conversationFixture } from "./fixture/conversation"

const Declaration = Schema.Struct({
  configuration: Schema.Struct({
    kernel_tools: Schema.Array(Schema.String),
    runner_tool_names: Schema.Array(Schema.String),
    lifecycle_hooks: Schema.Record(Schema.String, Schema.MutableJson),
    image_model: Schema.NullOr(Schema.String),
    compaction_policy: Schema.Struct({ mode: Schema.String }),
  }),
  prompt_documents: Schema.optional(Schema.Struct({ summarizer: Schema.Struct({ content: Schema.String }) })),
})

const Announcement = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          input_schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
        }),
      ),
    }),
  ),
})

test.each([
  { name: "another agent's dedicated", dedicated: true, owned: false, create: false },
  { name: "another agent's archived dedicated", dedicated: true, owned: false, create: false, state: "archived" },
  { name: "this agent's dedicated", dedicated: true, owned: true, create: false },
  { name: "non-dedicated", dedicated: false, owned: false, create: false },
  { name: "automatically created", dedicated: true, owned: true, create: true },
  { name: "restored API key", dedicated: false, owned: false, create: false, apiKey: true },
  { name: "renewing Agent", dedicated: false, owned: false, create: false, renewal: true },
  { name: "imported API key", dedicated: false, owned: false, create: false, importKeys: true },
])("validates $name workspace before reporting ready", async (fixture) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-runtime-")))
  const storage = join(directory, "storage")
  const project = join(directory, "project")
  const bound = join(project, "conversation")
  await Promise.all([mkdir(storage), mkdir(bound, { recursive: true })])
  const hour = 3600_000
  const clock = {
    time: Date.now(),
    wake: Promise.withResolvers<void>(),
    waits: [] as number[],
    verified: 0,
    refuse: false,
    lost: false,
  }
  const runtime = new NexusRuntime(
    storage,
    undefined,
    "renewal" in fixture
      ? {
          now: () => clock.time,
          wait: async (ms, signal) => {
            clock.waits.push(ms)
            const wake = clock.wake
            const stop = () => wake.resolve()
            if (signal.aborted) return
            signal.addEventListener("abort", stop, { once: true })
            await wake.promise
            signal.removeEventListener("abort", stop)
            clock.wake = Promise.withResolvers<void>()
          },
        }
      : undefined,
  )
  const transfer = "renewal" in fixture ? await executorFixture() : undefined
  const downloading = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  if (transfer) {
    const id = crypto.randomUUID()
    transfer.add("run", "download", "file_import", {
      executor_context: { "opencode.directory": project },
      addressed_to: { role: "runner", executor_public_id: "runner", presence: "online", last_seen_at: null },
      tool_input: { upload: id },
    })
    transfer.control.route = async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/attachments/" + id))
        return Response.json({
          upload: {
            public_id: id,
            filename: "working.txt",
            content_type: "text/plain",
            byte_size: 4,
            created_at: new Date().toISOString(),
          },
        })
      if (path.endsWith("/attachments/" + id + "/bytes")) {
        downloading.resolve()
        await finish.promise
        return new Response("done")
      }
    }
  }
  const changed = Promise.withResolvers<typeof Declaration.Type>()
  const declarations: (typeof Declaration.Type)[] = []
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
  const scheduleWrites: JsonObject[] = []
  const downloads = { bound: false, paths: [] as string[] }
  const announcements: (typeof Announcement.Type)[] = []
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
  const binding = {
    public_id: "binding",
    namespace: "rho.environment",
    key: "binding/runner",
    lock_version: 0,
    created_at: measured,
    updated_at: measured,
    value: { root: bound, directories: [], anchor: "conversation" },
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

      if (transfer && path.startsWith("/agent_api/v1/executor/inbox"))
        return fetch(new URL(path + url.search, transfer.server.url), {
          method: request.method,
          headers: request.headers,
          body: request.body ? await request.arrayBuffer() : undefined,
          signal: request.signal,
        })
      if (path === "/oauth/token") {
        const form = await request.formData()
        if (!form.has("refresh_token")) return Response.json({ error: "authorization_pending" }, { status: 400 })
        expect(form.get("refresh_token")).toBe(clock.verified ? "refresh-" + clock.verified : "fixture-refresh")
        clock.verified++
        if (clock.lost) return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({
          plane: "member",
          token_type: "Bearer",
          access_token: "member-" + clock.verified,
          executor_access_token: "executor-" + clock.verified,
          refresh_token: "refresh-" + clock.verified,
          expires_in: 14 * 86400,
        })
      }
      if (path === "/oauth/device_authorization")
        return Response.json({
          device_code: "device",
          user_code: "ABC",
          interval: 10,
          expires_in: 60,
          verification_uri: url.origin + "/verify",
          verification_uri_complete: url.origin + "/verify?code=ABC",
        })
      if (
        path === "/agent_api/v1/executors" &&
        clock.refuse &&
        request.headers.get("authorization") !== "Bearer member-2"
      )
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 })
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

      if (path === "/agent_api/v1/executor" || path === "/agent_api/v1/executor/announcement") {
        if (path.endsWith("/announcement"))
          announcements.push(Schema.decodeUnknownSync(Announcement)(await request.json()))

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
      }

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
      if (path.endsWith("/store_entries/binding")) return Response.json({ store_entry: binding })
      if (path.endsWith("/store_entries"))
        return Response.json({ store_entries: downloads.bound ? [binding] : [], pagination: { next_after: null } })
      if (path === "/agent_api/v1/mcp_connections")
        return Response.json({ mcp_connections: [], pagination: { next_after: null } })
      if (path === "/agent_api/v1/executors") return Response.json({ executors: [] })
      if (path === "/agent_api/v1/executors/runner")
        return Response.json({
          executor: {
            public_id: "runner",
            kind: "agent",
            status: "active",
            presence: "connected",
            service_roles: ["runner"],
            services: { runner: { environment: { root: project }, tools: [], documents: [] } },
          },
        })
      if (path.endsWith("/conversations/conversation"))
        return Response.json({
          conversation: conversationFixture({
            workspace_public_id: approval.workspace,
            answering_user_public_id: approval.agent,
            archived_at: approval.archived ? measured : null,
            default_runner: downloads.bound ? { executor_public_id: "runner", presence: "connected" } : null,
          }),
        })
      if (path.endsWith("/runs") && request.method === "POST") {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            run: Schema.Struct({
              steps: Schema.Array(
                Schema.Struct({ tool: Schema.Struct({ input: Schema.Struct({ path: Schema.String }) }) }),
              ),
            }),
          }),
        )(await request.json())
        downloads.paths.push(body.run.steps[0]!.tool.input.path)
        return Response.json(
          {
            run: { public_id: "download", status: "pending" },
            receipt: { accepted_task_keys: ["call_tool"], steps: [], resolution_tokens: {} },
          },
          { status: 201 },
        )
      }
      if (path.endsWith("/runs/download/start"))
        return Response.json({ error: { code: "not_startable" } }, { status: 409 })
      if (path.endsWith("/runs/download/tasks/call_tool"))
        return Response.json({
          task: {
            ...task(),
            key: "call_tool",
            status: "completed",
            tool_name: "files_bytes",
            content: [{ type: "resource_link", uri: "nexus://uploads/download", name: "notes.md" }],
          },
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
      if (path === "/agent_api/v1/workspaces/workspace/conversations/conversation/memory")
        return Response.json({
          memory: [
            {
              collection_public_id: "collection",
              public_id: "note",
              lock_version: 0,
              path: "conversation/note.md",
              bytesize: 5,
              content: null,
              written_at: measured,
            },
          ],
        })
      if (path.endsWith("/schedules/job/executions"))
        return Response.json({ executions: [], pagination: { next_after: null, last_cursor: null } })
      if (path.endsWith("/conversations/conversation/schedules") || path.endsWith("/schedules/job")) {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ schedule: Schema.Record(Schema.String, Schema.MutableJson) }),
        )(await request.json())
        scheduleWrites.push(body.schedule)
        return Response.json(
          {
            schedule: {
              public_id: "job",
              workspace_public_id: "workspace",
              conversation_public_id: "conversation",
              prompt: "Review",
              rule: { kind: "once", run_at: "2030-01-01T00:00:00Z" },
              status: "active",
              lock_version: 0,
              model: { model: "provider/selected" },
            },
          },
          { status: request.method === "POST" ? 201 : 200 },
        )
      }
      if (path === "/agent_api/v1/profile/configuration") {
        if (approval.refuseDeclaration)
          return Response.json(
            { error: { code: "invalid_configuration", message: "Fixture refused declaration" } },
            { status: 400 },
          )
        const payload = Schema.decodeUnknownSync(Declaration)(await request.json())
        declarations.push(payload)
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
            expires_at: new Date(clock.time + 7 * 24 * hour + hour).toISOString(),
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
      const code = announcements.flatMap((row) => row.services.runner?.tools ?? []).find((tool) => tool.name === "code")

      expect(code?.input_schema?.$id).toBe("urn:opencode:nexus:codemode:1")
      expect(code?.description).toContain("text(string) and console.log select model-visible text.")
      expect(code?.description).toContain("are UI-only structured output and are never rendered to the model.")
      expect(code?.description).toContain("text(JSON.stringify(result))")
      expect(code?.description).toMatch(/instead of repeating\s+a successful tool call just to display it/)
      expect(runtime.status().identity).toMatchObject({ agent: "agent", workspace: "workspace" })
      expect(runtime.status().error).toBeUndefined()
      expect(await runtime.policy("workspace", "conversation")).toMatchObject({ tools: [], runner: null })
      if (transfer) await downloading.promise
      expect(runtime.status().executor).toMatchObject({
        running: true,
        claimed: transfer ? 1 : 0,
        nudged: 0,
        canceled: 0,
        in_flight: transfer ? 1 : 0,
        starting: 0,
      })
      if ("apiKey" in fixture) {
        downloads.bound = true
        const download = {
          workspace: "workspace",
          conversation: "conversation",
          runner: "runner",
          receipt: "download",
          operation: { tool: "files_bytes", path: "./notes.md" },
        } as const

        expect(await runtime.operator(download)).toEqual({ upload: "download" })
        expect(downloads.paths).toEqual([join(bound, "notes.md")])
        for (const path of ["../notes.md", ".private/notes.md", join(project, "notes.md")])
          await expect(runtime.operator({ ...download, operation: { tool: "files_bytes", path } })).rejects.toThrow(
            "visible file",
          )
        expect(downloads.paths).toHaveLength(1)
        downloads.bound = false

        await runtime.manage({
          action: "schedule.create",
          workspace: "workspace",
          conversation: "conversation",
          key: "schedule-create",
          prompt: "Review",
          model: "provider/selected",
          rule: { kind: "once", run_at: "2030-01-01T00:00:00Z" },
        })
        await runtime.manage({
          action: "schedule.update",
          workspace: "workspace",
          conversation: "conversation",
          id: "job",
          version: 0,
          prompt: "Review",
          model: "provider/updated",
          rule: { kind: "once", run_at: "2030-01-01T00:00:00Z" },
        })
        await runtime.manage({
          action: "schedule.executions",
          workspace: "workspace",
          conversation: "conversation",
          id: "job",
          after: "next-execution",
        })
        expect(scheduleWrites.map((write) => write.model)).toEqual([
          { model: "provider/selected" },
          { model: "provider/updated" },
        ])
        expect(calls.find((call) => call.path.endsWith("/schedules/job/executions"))?.after).toBe("next-execution")
        const memory = { action: "application.memory", conversation: "conversation", command: "ls" } as const

        expect(await runtime.manage(memory)).toBe("conversation/note.md (5 bytes)")
        expect(await runtime.manage({ ...memory, format: "json" }, nexus.url.origin, "human")).toMatchObject([
          { path: "conversation/note.md", lock_version: 0 },
        ])
        expect(
          calls.filter((call) => call.path.endsWith("/conversations/conversation/memory")).at(-1)?.authorization,
        ).toBe("Bearer human")
      }
      if ("apiKey" in fixture) {
        await runtime.manage({ action: "settings.update", patch: { subagent_default: false } })
        await runtime.configureExtension({
          id: "nexus.codemode",
          operations: [{ op: "set", path: ["default"], value: "off" }],
        })
        expect(await runtime.manage({ action: "application.defaults" })).toMatchObject({
          code_mode: false,
          subagent: false,
          available: true,
          code_mode_available: true,
        })
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
        const hooks = { turn_start: { tool: "verify", timeout_ms: 30000 } }
        await runtime.configureExtension({
          id: "nexus.lifecycle-hooks",
          operations: [{ op: "set", path: ["turn_start"], value: hooks.turn_start }],
        })
        await published(
          () => JSON.stringify(declarations.at(-1)?.configuration.lifecycle_hooks) === JSON.stringify(hooks),
        )
        await runtime.configureExtension({ id: "nexus.coding", enabled: false })
        await runtime.configureExtension({ id: "nexus.checkpoints", enabled: false })
        await published(
          () => !announcements.at(-1)?.services.runner.tools.some((tool) => tool.name === "checkpoint_restore"),
        )
        expect(announcements.at(-1)?.services.runner.tools.map((tool) => tool.name)).not.toContain("read")
        await published(() => !declarations.at(-1)?.configuration.runner_tool_names.includes("read"))
        expect(declarations.at(-1)?.configuration.runner_tool_names).toContain("code")
        await runtime.configureExtension({ id: "nexus.coding", enabled: true })
        await runtime.configureExtension({ id: "nexus.lifecycle-hooks", enabled: false })
        await published(() => JSON.stringify(declarations.at(-1)?.configuration.lifecycle_hooks) === "{}")
        expect(declarations.at(-1)?.configuration.runner_tool_names).toContain("read")
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

    if (transfer) {
      await downloading.promise
      expect(runtime.status().executor?.in_flight).toBe(1)
      expect(clock.waits).toEqual([hour])
      expect(clock.verified).toBe(0)
      clock.time += hour
      clock.wake.resolve()
      await published(() => clock.waits.length === 2)
      expect(await Bun.file(join(storage, "agent.json")).json()).toMatchObject({
        rotation: 1,
        refresh_token: "refresh-1",
      })
      const announced = announcements.length
      clock.refuse = true
      await runtime.runners()
      expect(clock.verified).toBe(2)
      expect(announcements).toHaveLength(announced)
      expect(runtime.status().state).toBe("ready")
      finish.resolve()
      await published(() => transfer.commits.length === 1)
      expect(transfer.commits[0].body).toMatchObject({ outcome: "completed", structured_content: { byte_size: 4 } })
      clock.time += 7 * 24 * hour
      clock.lost = true
      clock.wake.resolve()
      await published(() => runtime.status().state === "unpaired")
      expect(runtime.status().error).toContain("Pair")
      expect(await Bun.file(join(storage, "agent.json")).exists()).toBe(false)
      expect(
        (await runtime.pair({ origin: nexus.url.origin, model: "fixture", directory: project, workspace: "" })).state,
      ).toBe("pairing")
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
    finish.resolve()
    await runtime.close()
    await transfer?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

async function published(ready: () => boolean) {
  const deadline = Date.now() + 4000
  while (!ready() && Date.now() < deadline) await Bun.sleep(1)
  expect(ready()).toBe(true)
}
