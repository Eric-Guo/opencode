import { expect, test } from "bun:test"
import { Toolsets, type CredentialDocument, type Workspace, type JsonObject, type StoreEntry } from "@cybros/agent"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NexusRuntime } from "../src/runtime"
import { checkInPrefix } from "../src/routines"
import { executorFixture } from "./fixture/executor"
import { atomic } from "../src/storage"
import { Schema } from "effect"
import { queuedInference } from "./fixture/inference"
import { conversationFixture } from "./fixture/conversation"

const Declaration = Schema.Struct({
  configuration: Schema.Struct({
    kernel_tools: Schema.Array(Schema.String),
    runner_tool_names: Schema.Array(Schema.String),
    tool_definitions: Schema.Array(Schema.MutableJson),
    lifecycle_hooks: Schema.Record(Schema.String, Schema.MutableJson),
    image_model: Schema.NullOr(Schema.String),
    compaction_policy: Schema.Struct({ mode: Schema.String, model: Schema.optional(Schema.String) }),
  }),
  prompt_documents: Schema.optional(
    Schema.Struct({ summarizer: Schema.NullOr(Schema.Struct({ content: Schema.String })) }),
  ),
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

test("loads the public Nexus runtime in a fresh process", async () => {
  // Other tests can initialize Core services first and mask an import cycle.
  await Bun.$`${process.execPath} -e 'await import("@opencode/nexus-runtime")'`.cwd(join(import.meta.dir, "..")).quiet()
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
  const deskCreates: JsonObject[] = []
  const speakerRequests: JsonObject[] = []
  const profileEntries = new Map<string, StoreEntry>()
  const downloads = { bound: false, paths: [] as string[] }
  const policyTools: JsonObject[] = []
  const scheduledChat = { captured: false, pin: "" }
  const subagentOff = { active: false }
  const announcements: (typeof Announcement.Type)[] = []
  const measured = new Date().toISOString()
  const preset: StoreEntry = {
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
  const modes = {
    ...binding,
    public_id: "modes",
    namespace: "opencode",
    key: "modes",
    value: { code_mode: true, subagent: false },
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

      if (path === "/agent_api/v1/workspaces/workspace/inference_requests" && request.method === "POST") {
        expect(request.headers.get("idempotency-key")).toBe("existing-request")
        return Response.json({ inference_request: { ...queuedInference, result: { status: "completed", output_text: "done" } } })
      }
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
        if (scheduledChat.captured) {
          expect(body.conversation_public_id).toBe("conversation")
          expect(body.configuration).toBeUndefined()
        } else {
          expect(body.configuration).toBeDefined()
          expect(body.conversation_public_id).toBeUndefined()
        }
        expect(body.default_runner_executor_public_id).toBeNull()
        return Response.json({ tool_definitions: policyTools, environment: {} })
      }
      if (path === "/agent_api/v1/tools")
        return Response.json({
          tools: Toolsets.names("conversation", "history", "skills", "images", "schedules", "memory").map(
            (canonical_name) => ({
              canonical_name,
              name:
                canonical_name === "nexus.memory.read"
                  ? "memory_read"
                  : canonical_name === "nexus.skill.load"
                    ? "skill"
                    : canonical_name.split(".").at(-1),
              effect_profile: {},
              definition: {},
            }),
          ),
        })
      if (path === "/agent_api/v1/profile/ingress_speakers" && request.method === "POST") {
        const body = (await request.json()) as { ingress_speaker: JsonObject }

        speakerRequests.push(body.ingress_speaker)
        return Response.json(
          { ingress_speaker: { kind: "ingress", ...body.ingress_speaker, public_id: "owner" } },
          { status: 201 },
        )
      }
      if (path === "/agent_api/v1/workspaces/workspace/conversations" && request.method === "POST") {
        const body = (await request.json()) as { conversation: JsonObject }

        deskCreates.push(body.conversation)
        return Response.json(
          {
            conversation: conversationFixture({
              ...body.conversation,
              public_id: "desk",
              answering_user_public_id: "agent",
            }),
          },
          { status: 201 },
        )
      }
      if (path === "/agent_api/v1/workspaces/workspace/conversations/desk")
        return Response.json({
          conversation: conversationFixture({
            public_id: "desk",
            answering_user_public_id: "agent",
            metadata: { "opencode.surface": "personal_desk", rho_bot_public_id: "personal" },
          }),
        })
      if (path === "/agent_api/v1/profile/store_entries" && request.method === "POST") {
        const body = (await request.json()) as { store_entry: { namespace: string; key: string; value: JsonObject } }
        const entry: StoreEntry = {
          ...body.store_entry,
          public_id: "entry-" + body.store_entry.namespace,
          lock_version: 0,
          created_at: measured,
          updated_at: measured,
        }

        profileEntries.set(entry.public_id, entry)
        return Response.json({ store_entry: entry }, { status: 201 })
      }
      if (path === "/agent_api/v1/profile/store_entries")
        return Response.json({
          store_entries: [preset, ...profileEntries.values()],
          pagination: { next_after: null },
        })
      if (path.startsWith("/agent_api/v1/profile/store_entries/") && !path.endsWith("/presets")) {
        const id = path.split("/").at(-1)!
        const entry = profileEntries.get(id)

        if (!entry) return Response.json({ error: { code: "not_found" } }, { status: 404 })
        if (request.method === "PATCH") {
          const body = (await request.json()) as { store_entry: { value: JsonObject; lock_version: number } }

          if (body.store_entry.lock_version !== entry.lock_version)
            return Response.json({ error: { code: "stale_object" } }, { status: 409 })
          entry.value = body.store_entry.value
          entry.lock_version++
        }
        return Response.json({ store_entry: entry })
      }
      if (path === "/agent_api/v1/profile/store_entries/presets") {
        if (request.method === "PATCH") {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              store_entry: Schema.Struct({ lock_version: Schema.Int, value: Schema.MutableJson }),
            }),
          )(await request.json())

          expect(body.store_entry.lock_version).toBe(preset.lock_version)
          preset.value = body.store_entry.value
          preset.lock_version++
        }

        return Response.json({ store_entry: preset })
      }
      if (path.endsWith("/store_entries/binding")) return Response.json({ store_entry: binding })
      if (path.endsWith("/store_entries/modes")) return Response.json({ store_entry: modes })
      if (path.endsWith("/store_entries"))
        return Response.json({
          store_entries: [...(downloads.bound ? [binding] : []), ...(subagentOff.active ? [modes] : [])],
          pagination: { next_after: null },
        })
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
      if (path.endsWith("/conversations/scratch") && request.method === "DELETE")
        return new Response(null, { status: 204 })
      if (path.endsWith("/conversations/conversation") || path.endsWith("/conversations/scratch"))
        return Response.json({
          conversation: conversationFixture({
            public_id: path.endsWith("/scratch") ? "scratch" : "conversation",
            workspace_public_id: approval.workspace,
            agent_configuration_present: scheduledChat.captured,
            metadata: scheduledChat.pin ? { "opencode.initial_model": scheduledChat.pin } : {},
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
      if (
        path.endsWith("/conversations/conversation/schedules") ||
        path.endsWith("/conversations/desk/schedules") ||
        path.endsWith("/schedules/job")
      ) {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ schedule: Schema.Record(Schema.String, Schema.MutableJson) }),
        )(await request.json())
        scheduleWrites.push(body.schedule)
        return Response.json(
          {
            schedule: {
              public_id: "job",
              workspace_public_id: "workspace",
              conversation_public_id: path.includes("/conversations/desk/") ? "desk" : "conversation",
              prompt: "Review",
              wake: "auto",
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
    if ("apiKey" in fixture) {
      await mkdir(join(storage, "adaptations"))
      await writeFile(
        join(storage, "adaptations", "summary.yml"),
        "format: 1\nrow: summary\nmodels: [summarizer]\ntool_style: [nexus]\nsummarizer_prompt: Summarize by pointers.\n",
      )
    }
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
      expect(announcements.at(-1)?.services.agent?.tools.map((tool) => tool.name)).toEqual([
        "channel_dispatch",
        "propose_skill",
        "list_extensions",
        "manage_extension",
      ])
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
        expect(await runtime.manage({ action: "inference.list" })).toEqual([])
        await expect(runtime.manage({ action: "inference.list" }, nexus.url.origin, "human")).rejects.toThrow(
          "paired Agent credential",
        )
        await expect(runtime.manage({ action: "inference.subscribe", request: "missing" })).rejects.toThrow(
          "not following",
        )
        const accepted = await runtime.manage({
          action: "inference.create", model: "fixture/model", key: "existing-request", input: "hello",
        })
        expect(accepted).toMatchObject({ public_id: queuedInference.public_id, complete: true, text: "done" })
        expect(await runtime.manage({ action: "inference.list" })).toEqual([accepted])
        expect(await runtime.manage({ action: "inference.list", workspace: "other" })).toEqual([])
        expect(
          await runtime.manage({
            action: "application.operation",
            operation: { action: "adaptations", model: "provider/summarizer" },
          }),
        ).toMatchObject({
          model: "provider/summarizer",
          facts: null,
          catalog_error: expect.any(String),
          adaptations: { row: "summary", source: "local", selection: "exact", matched: "summarizer" },
        })
        expect(
          await runtime.manage({
            action: "extension.call",
            name: "editor.mcp.attach",
            input: {
              workspace: "workspace",
              conversation: "conversation",
              cwd: "/remote/project",
              servers: [{ name: "editor", command: "peer" }],
            },
          }),
        ).toMatchObject({ tools: [], issues: [expect.stringContaining("mcp_unavailable")] })
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

        policyTools.push({ function: { name: "read" } }, { function: { name: "write" } })
        await runtime.manage({
          action: "schedule.create",
          workspace: "workspace",
          conversation: "conversation",
          key: "schedule-create",
          prompt: "Review",
          model: "provider/selected",
          reasoning_enabled: false,
          fallback_models: ["provider/backup"],
          tool_names: ["read", "unavailable"],
          wake: "passive",
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
          wake: "auto",
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
          { model: "provider/selected", reasoning_enabled: false },
          { model: "provider/updated" },
        ])
        await runtime.manage({
          action: "schedule.update",
          workspace: "workspace",
          conversation: "conversation",
          id: "job",
          version: 1,
          prompt: "Updated prompt",
        })
        expect(scheduleWrites.at(-1)).toEqual({ expected_lock_version: 1, prompt: "Updated prompt" })
        expect(scheduleWrites[0]).toMatchObject({
          model_selection: { source: "explicit", constraint: "route", model: "provider/selected" },
          fallback_models: ["provider/backup"],
          tool_names: ["read"],
          approval_mode: "ask",
          wake: "passive",
          executor_contexts: { runner: { "opencode.mcp": { anchor: null } } },
        })
        expect(scheduleWrites[1]).toMatchObject({ expected_lock_version: 0, wake: "auto" })
        await runtime.manage({
          action: "schedule.update",
          workspace: "workspace",
          conversation: "conversation",
          id: "job",
          version: 2,
          name: null,
          reasoning_enabled: false,
          tool_names: [],
          fallback_models: [],
        })
        expect(scheduleWrites.at(-1)).toEqual({
          expected_lock_version: 2,
          name: null,
          model: { reasoning_enabled: false },
          tool_names: [],
          fallback_models: [],
        })
        scheduledChat.pin = "provider/pin"
        const scheduled = {
          action: "schedule.create",
          workspace: "workspace",
          conversation: "conversation",
          key: "pin",
          prompt: "Review",
          rule: { kind: "once", run_at: "2030-01-01T00:00:00Z" },
        } as const
        expect(
          await runtime.manage({ action: "schedule.defaults", workspace: "workspace", conversation: "conversation" }),
        ).toMatchObject({ model: "provider/pin" })
        await runtime.manage(scheduled)
        expect(scheduleWrites.at(-1)).toMatchObject({
          model: { model: "provider/pin" },
          model_selection: { source: "explicit", constraint: "route" },
          tool_names: ["read", "write"],
        })
        scheduledChat.captured = true
        await runtime.manage({ ...scheduled, key: "captured", reasoning_enabled: false })
        expect(scheduleWrites.at(-1)?.model).toEqual({ reasoning_enabled: false })
        expect(scheduleWrites.at(-1)).not.toHaveProperty("model_selection")
        expect(scheduleWrites.at(-1)).not.toHaveProperty("fallback_models")
        scheduledChat.captured = false
        scheduledChat.pin = ""
        policyTools.length = 0
        expect(calls.find((call) => call.path.endsWith("/schedules/job/executions"))?.after).toBe("next-execution")
        await runtime.manage({
          action: "routine.create",
          workspace: "workspace",
          key: "routine-create",
          name: "Morning check",
          what: "Check the inbox",
          does: "check_in",
          rule: { kind: "daily", local_time: "09:00", time_zone: "UTC" },
        })
        expect(speakerRequests).toEqual([{ channel_key: "rho:agent", external_id: "owner", display_name: "Owner" }])
        expect(deskCreates).toHaveLength(1)
        expect(deskCreates[0]).toMatchObject({
          title: "Personal Desk",
          metadata: { "opencode.surface": "personal_desk", rho_bot_public_id: "personal" },
        })
        expect(scheduleWrites.at(-1)).toMatchObject({
          prompt: checkInPrefix + "Check the inbox",
          wake: "passive",
          name: "Morning check",
          rule: { kind: "daily", local_time: "09:00", time_zone: "UTC" },
          speaker_public_id: "owner",
          answering_user_public_id: "agent",
          approval_mode: "ask",
        })
        await runtime.manage({
          action: "routine.create",
          workspace: "workspace",
          conversation: "conversation",
          key: "routine-act",
          what: "Summarize the day",
          rule: { kind: "once", run_at: "2030-01-01T00:00:00Z" },
        })
        expect(deskCreates).toHaveLength(1)
        expect(scheduleWrites.at(-1)).toMatchObject({
          prompt: "Summarize the day",
          wake: "auto",
          speaker_public_id: "owner",
        })
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
        expect(
          await runtime.manage({
            action: "application.operation",
            operation: { action: "delete", conversation: "scratch" },
          }),
        ).toBeNull()
        await runtime.manage({ action: "settings.update", patch: { subagent_default: false } })
        policyTools.push(
          { type: "function", function: { name: "request" } },
          { type: "function", function: { name: "spawn_agent" }, canonical: "nexus.conversation.spawn" },
          { type: "function", function: { name: "links" } },
        )
        subagentOff.active = true
        expect(await runtime.policy("workspace", "conversation")).toMatchObject({ tools: ["links"] })
        subagentOff.active = false
        policyTools.length = 0
        await runtime.configureExtension({
          id: "nexus.compaction",
          operations: [{ op: "set", path: ["model"], value: "provider/summarizer" }],
        })
        await published(() => declarations.at(-1)?.prompt_documents?.summarizer?.content === "Summarize by pointers.")
        expect(await runtime.policy("workspace", "conversation")).toMatchObject({
          agent_configuration: { summarizer: { content: "Summarize by pointers." } },
        })
        await runtime.manage({ action: "extension.call", name: "runners", input: {} })
        expect(declarations.at(-1)?.prompt_documents?.summarizer).toEqual({ content: "Summarize by pointers." })
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
          expect(declarations.at(-1)?.prompt_documents?.summarizer).toEqual({ content: "Summarize by pointers." })
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
        await runtime.manage({ action: "settings.update", patch: { adaptations: "off" } })
        expect(declarations.at(-1)).toMatchObject({
          configuration: { compaction_policy: { mode: "kernel", model: "provider/summarizer" } },
          prompt_documents: { summarizer: null },
        })
        expect(await runtime.policy("workspace", "conversation")).toMatchObject({
          agent_configuration: { summarizer: null },
        })

        await runtime.manage({
          action: "preset.replace",
          id: "main-preset",
          value: {
            name: "Main",
            description: "Selected tools",
            configuration: { tools: ["memory_read"], runner_tool_names: [] },
          },
        })
        expect(declarations.at(-1)?.configuration).toMatchObject({
          kernel_tools: ["nexus.memory.read"],
          runner_tool_names: [],
        })
        expect((await runtime.policy("workspace", "conversation")).agent_configuration).toMatchObject({
          kernel_tools: ["nexus.memory.read"],
          runner_tool_names: [],
        })
      }
      if (fixture.owned && !fixture.create) {
        expect(declarations[0]?.configuration.kernel_tools).toContain("nexus.conversation.request")
        expect(declarations[0]?.configuration.kernel_tools).toContain("nexus.conversation.links")
        expect(declarations[0]?.configuration.kernel_tools).not.toContain("nexus.image.generate")
        expect(declarations[0]?.configuration.tool_definitions).toContainEqual({
          type: "function",
          function: { name: "skill" },
          canonical: "nexus.skill.load",
          defer_loading: true,
        })
        expect(declarations[0]?.prompt_documents?.summarizer?.content).toContain("Goal:")
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
        expect(declaration.configuration.kernel_tools).toContain("nexus.image.generate")
        expect(declaration.prompt_documents?.summarizer).toBeNull()
        await runtime.configureExtension({ id: "nexus.images", operations: [{ op: "unset", path: ["model"] }] })
        await published(() => declarations.at(-1)?.configuration.image_model === null)
        expect(declarations.at(-1)?.configuration.image_model).toBeNull()
        expect(declarations.at(-1)?.configuration.kernel_tools).not.toContain("nexus.image.generate")
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
