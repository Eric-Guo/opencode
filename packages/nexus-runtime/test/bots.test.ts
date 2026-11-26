import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { Presets } from "../src/presets"
import { Bots } from "../src/bots"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"
import { summaryPrompt } from "../src/capabilities"

test("Bot identities retain settings and recover switches without redirecting accepted work", async () => {
  const agents = new Map<string, JsonObject>()
  const conversations = new Map<string, JsonObject>()
  const receipts = new Map<string, string>()
  const calls: string[] = []
  const fault = { loseConversation: false, loseInput: false, refuseDeclaration: true }
  const inputs: JsonObject[] = []
  const declarations: JsonObject[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname

    if (path.includes("/store_entries")) return

    calls.push(request.method + " " + path)

    if (path.endsWith("/inputs") && request.method === "POST") {
      const input = (await request.json()) as { input: JsonObject }
      inputs.push(input.input)
      if (fault.loseInput) {
        fault.loseInput = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json({ input: inputFixture(input.input) }, { status: 202 })
    }

    if (path.endsWith("/tools")) return Response.json({ tools: [] })

    if (path.endsWith("/profile/agents")) return Response.json({ agents: [...agents.values()] })
    if (path.includes("/profile/agents/")) {
      const name = path.split("/").at(-1)!
      const input = (await request.json()) as JsonObject

      declarations.push(input)
      if (fault.refuseDeclaration) {
        fault.refuseDeclaration = false
        return Response.json({ error: { code: "unavailable" } }, { status: 503 })
      }

      const agent: JsonObject = {
        ...input,
        name,
        public_id: agents.get(name)?.public_id ?? crypto.randomUUID(),
        scope: "instance",
        configuration: {
          kernel_tools: [],
          runner_executor_public_ids: [],
          mcp_tools: [],
          fallback_models: [],
          ...(input.configuration as JsonObject),
        },
        handle: "@" + name,
        agent_identifier: name,
        steward_public_id: "human",
        kind: "agent",
        derived_from_public_id: "main",
        summarizer: input.summarizer ?? null,
      }

      agents.set(name, agent)
      return Response.json({ agent })
    }
    if (/\/workspaces\/[^/]+$/.test(path))
      return Response.json({
        workspace: {
          public_id: path.split("/").at(-1),
          name: "Home",
          state: "active",
          dedicated: false,
          access_mode: "private",
          lock_version: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {},
          tool_provider_overrides: {},
          owner: { public_id: "human", display_name: "Human" },
          creator: { public_id: "main", display_name: "Main", kind: "agent" },
        },
      })
    if (path.endsWith("/conversations") && request.method === "POST") {
      const input = (await request.json()) as { conversation: JsonObject }
      const key = request.headers.get("idempotency-key")!
      const id = receipts.get(key) ?? crypto.randomUUID()

      if (!conversations.has(id))
        conversations.set(
          id,
          conversationFixture({
            ...input.conversation,
            public_id: id,
            workspace_public_id: path.split("/").at(-2)!,
          }),
        )
      receipts.set(key, id)
      if (fault.loseConversation) {
        fault.loseConversation = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json({ conversation: conversations.get(id) }, { status: 201 })
    }
    const id = path.split("/").at(path.endsWith("/archive") || path.endsWith("/unarchive") ? -2 : -1)!
    const conversation = conversations.get(id)

    if (conversation) {
      if (path.endsWith("/archive")) conversation.archived_at = new Date().toISOString()
      if (path.endsWith("/unarchive")) conversation.archived_at = null
      return Response.json({ conversation })
    }

    return Response.json({ error: { code: "not_found" } }, { status: 404 })
  })
  const adaptation = { prompt: "Keep the initial summary." }
  const application = new NexusApplication(
    fixture.client,
    { agent: "main", runner: "runner", workspace: "workspace" },
    () => ({
      default_model: "provider/model",
      runner_tool_names: ["read", "write", "code"],
      compaction_policy: { mode: "kernel" },
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => ({
      code_mode: true,
      subagent: true,
      title_model: null,
      summarizer: (policy) => summaryPrompt(policy, () => adaptation.prompt),
    }),
  )
  const presets = application.presets
  const bots = application.bots

  try {
    const create = {
      action: "bot.create",
      name: "assistant",
      description: "Personal assistant",
      settings: { home_workspace_public_id: "workspace" },
    } as const

    await expect(bots.command(create)).rejects.toThrow()
    adaptation.prompt = "Use the updated adaptation."
    const created = await bots.command(create)
    expect(declarations.slice(0, 2).map((item) => item.summarizer)).toEqual([
      "Keep the initial summary.",
      "Keep the initial summary.",
    ])
    const id = String((created as { public_id: string }).public_id)

    const catalog = await presets.catalog()
    const selected = catalog.presets.find((row) => row.name === "worker")!
    await bots.command({ action: "bot.configure", id, settings: { preset_public_id: selected.public_id } })
    await expect(presets.command({ action: "preset.remove", id: selected.public_id })).rejects.toThrow(
      /in use by Bot .*assistant/i,
    )
    expect((await presets.catalog()).presets).toContainEqual(selected)
    await bots.command({
      action: "bot.configure",
      id,
      settings: { preset_public_id: catalog.default_bot_preset_public_id },
    })
    await presets.command({ action: "preset.remove", id: selected.public_id })
    expect(conversations.size).toBe(0)
    await bots.command({ action: "bot.read", id })
    expect(conversations.size).toBe(0)
    const first = (await bots.command({ action: "bot.current", id, key: "first" })) as {
      selected: { public_id: string }
      replayed: boolean
    }

    expect(first.replayed).toBe(false)
    expect(conversations.size).toBe(1)
    expect(conversations.get(first.selected.public_id)?.memory_context).toEqual({
      bindings: [
        { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
        { name: "speaker", source: { scope: "speaker" }, access: "read_write" },
        { name: "agent", source: { scope: "agent" }, access: "read_write" },
        { name: "workspace", source: { scope: "workspace" }, access: "read_write" },
      ],
      mode: "index",
    })
    fault.loseInput = true
    const input = {
      action: "bot.submit" as const,
      id,
      workspace: "workspace",
      conversation: first.selected.public_id,
      key: "bot-input",
      text: "Help",
    }
    await expect(bots.submit(input)).rejects.toThrow()
    const restored = new Bots(
      fixture.client,
      new Presets(fixture.client),
      () => ({ default_model: "provider/model" }),
      "runner",
    )

    expect(await restored.command({ action: "bot.current", id, key: "first" })).toMatchObject({
      replayed: true,
      selected: first.selected,
    })
    fault.loseConversation = true
    await expect(restored.command({ action: "bot.new", id, key: "second" })).rejects.toThrow()
    const reconnected = new Bots(
      fixture.client,
      new Presets(fixture.client),
      () => ({
        default_model: "provider/model",
        kernel_tools: ["nexus.conversation.request", "nexus.conversation.links"],
      }),
      "runner",
    )
    const second = (await reconnected.command({ action: "bot.new", id, key: "second" })) as {
      selected: { public_id: string }
    }

    expect(second.selected.public_id).not.toBe(first.selected.public_id)
    expect(conversations.get(first.selected.public_id)?.archived_at).toBeString()
    expect(calls.some((call) => call.endsWith("/cancel"))).toBe(false)
    expect(conversations.size).toBe(2)
    await expect(reconnected.submit({ ...input, key: "non-current" })).rejects.toThrow("current conversation")
    await reconnected.submit(input)
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(inputs[0]).toMatchObject({
      agent_configuration: {
        runner_tool_names: ["read", "write"],
        summarizer: { content: "Use the updated adaptation." },
      },
    })
    const current = { ...input, conversation: second.selected.public_id }
    await reconnected.submit({ ...current, key: "pin", model: "provider/explicit" })
    await reconnected.submit({ ...current, key: "inherit" })
    expect(inputs.at(-1)?.model_selection).toMatchObject({ source: "explicit", model: "provider/explicit" })
    await reconnected.submit({ ...current, key: "automatic", model: null })
    expect(inputs.at(-1)?.model_selection).toMatchObject({ source: "default", model: "provider/model" })
    await reconnected.command({
      action: "bot.configure",
      id,
      settings: { home_workspace_public_id: null, subagent: false, audience: "external" },
    })
    expect(agents.get("bot-assistant")?.configuration).toMatchObject({
      kernel_tools: ["nexus.conversation.links"],
      runner_tool_names: [],
      runner_executor_public_ids: [],
      conversation_reach: "subtree",
      approval_mode: "rules",
    })
    await expect(reconnected.command({ action: "bot.configure", id, settings: { audience: "owner" } })).rejects.toThrow(
      "Duplicate",
    )
    await expect(reconnected.command({ action: "bot.new", id, key: "third" })).rejects.toThrow("Home Workspace")
    const resumed = await reconnected.command({
      action: "bot.resume",
      id,
      key: "resume",
      workspace: "workspace",
      conversation: first.selected.public_id,
    })

    expect(resumed).toMatchObject({ selected: first.selected })
    expect(conversations.get(first.selected.public_id)?.archived_at).toBeNull()
    await expect(reconnected.command({ action: "bot.new", id, key: "resume" })).rejects.toThrow("another Bot command")

    fault.loseConversation = true
    const move = { action: "bot.workspace" as const, id, key: "move-home", workspace: "workspace-next" }

    await expect(reconnected.command(move)).rejects.toThrow()
    expect(await reconnected.command({ action: "bot.read", id })).toMatchObject({
      settings: { home_workspace_public_id: null },
      current: first.selected,
    })

    const restarted = new Bots(
      fixture.client,
      new Presets(fixture.client),
      () => ({ default_model: "provider/model" }),
      "runner",
    )
    const moved = await restarted.command(move)

    expect(moved).toMatchObject({ selected: { workspace_public_id: "workspace-next" }, replayed: true })
    expect([...conversations.values()].find((row) => row.workspace_public_id === "workspace-next")?.memory_context).toEqual({
      bindings: [
        { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
        { name: "speaker", source: { scope: "speaker" }, access: "read_write" },
        { name: "workspace", source: { scope: "workspace" }, access: "read" },
      ],
      mode: "index",
    })
    expect(await restarted.command({ action: "bot.read", id })).toMatchObject({
      settings: { home_workspace_public_id: "workspace-next" },
      current: { workspace_public_id: "workspace-next" },
    })
    expect(conversations.size).toBe(3)
    await restarted.command(move)
    expect(conversations.size).toBe(3)
    await expect(restarted.command({ ...move, workspace: "other" })).rejects.toThrow("another Bot command")
  } finally {
    fixture.server.stop(true)
  }
})

test("personal is a synthetic owner Bot without a profile agent row", async () => {
  const conversations = new Map<string, JsonObject>()
  const created: JsonObject[] = []
  const inputs: JsonObject[] = []
  const lists: Record<string, string>[] = []
  const fixture = storeFixture(async (request) => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path.includes("/store_entries")) return

    if (path.endsWith("/profile"))
      return Response.json({
        member: { public_id: "main", handle: "@main", kind: "agent", role: "member" },
        credential: { plane: "member" },
        measured_at: new Date().toISOString(),
      })
    if (path.endsWith("/profile/agents")) return Response.json({ agents: [] })
    if (path.endsWith("/tools")) return Response.json({ tools: [] })
    if (path.endsWith("/workspaces"))
      return Response.json({
        workspaces: [
          {
            public_id: "workspace",
            name: "Home",
            state: "active",
            dedicated: false,
            access_mode: "private",
            lock_version: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: {},
            tool_provider_overrides: {},
            owner: { public_id: "human", display_name: "Human" },
            creator: { public_id: "main", display_name: "Main", kind: "agent" },
          },
        ],
        pagination: { next_after: null },
      })
    if (/\/workspaces\/[^/]+$/.test(path))
      return Response.json({
        workspace: {
          public_id: path.split("/").at(-1),
          name: "Home",
          state: "active",
          dedicated: false,
          access_mode: "private",
          lock_version: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {},
          tool_provider_overrides: {},
          owner: { public_id: "human", display_name: "Human" },
          creator: { public_id: "main", display_name: "Main", kind: "agent" },
        },
      })
    if (path.endsWith("/conversations") && request.method === "GET") {
      lists.push(Object.fromEntries(url.searchParams))
      return Response.json({ conversations: [...conversations.values()], pagination: { next_after: null } })
    }
    if (path.endsWith("/conversations") && request.method === "POST") {
      const input = (await request.json()) as { conversation: JsonObject }
      const id = crypto.randomUUID()
      const row = conversationFixture({
        ...input.conversation,
        public_id: id,
        workspace_public_id: path.split("/").at(-2)!,
      })

      conversations.set(id, row)
      created.push(input.conversation)
      return Response.json({ conversation: row }, { status: 201 })
    }
    if (path.endsWith("/inputs") && request.method === "POST") {
      const input = (await request.json()) as { input: JsonObject }
      inputs.push(input.input)
      return Response.json({ input: inputFixture(input.input) }, { status: 202 })
    }
    const id = path.split("/").at(path.endsWith("/archive") || path.endsWith("/unarchive") ? -2 : -1)!
    const conversation = conversations.get(id)

    if (conversation) {
      if (path.endsWith("/archive")) conversation.archived_at = new Date().toISOString()
      if (path.endsWith("/unarchive")) conversation.archived_at = null
      return Response.json({ conversation })
    }

    return Response.json({ error: { code: "not_found" } }, { status: 404 })
  })
  const bots = new Bots(
    fixture.client,
    new Presets(fixture.client),
    () => ({ default_model: "provider/model" }),
    "runner",
  )

  try {
    expect(await bots.command({ action: "bot.read", id: "personal" })).toMatchObject({
      public_id: "personal",
      name: "personal",
      handle: "personal",
      display_name: "Personal Agent",
      description: "Direct personal reach for the owner.",
      configuration: { default_model: "provider/model" },
      settings: { audience: "owner", home_workspace_public_id: null },
      current: null,
    })
    await expect(bots.command({ action: "bot.remove", id: "personal" })).rejects.toThrow("Personal Agent")

    const opened = (await bots.command({ action: "bot.current", id: "personal", key: "open" })) as {
      selected: { public_id: string; workspace_public_id: string }
    }

    expect(opened.selected.workspace_public_id).toBe("workspace")
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      answering_user_public_id: "main",
      default_runner_executor_public_id: "runner",
      metadata: { "opencode.bot": "personal", "opencode.surface": "personal_desk" },
      memory_context: {
        bindings: [
          { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
          { name: "speaker", source: { scope: "speaker" }, access: "read_write" },
          { name: "agent", source: { scope: "agent" }, access: "read_write" },
          { name: "workspace", source: { scope: "workspace" }, access: "read_write" },
        ],
        mode: "index",
      },
    })

    const earlier = crypto.randomUUID()

    conversations.set(
      earlier,
      conversationFixture({
        public_id: earlier,
        answering_user_public_id: "main",
        metadata: { "opencode.bot": "personal" },
      }),
    )
    await bots.submit({
      action: "bot.submit",
      id: "personal",
      workspace: "workspace",
      conversation: earlier,
      key: "direct",
      text: "Hello",
    })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      answering_user_public_id: "main",
      model: { model: "provider/model" },
      model_selection: { source: "default", model: "provider/model" },
    })

    await bots.command({ action: "bot.history", id: "personal" })
    expect(lists.at(-1)).toMatchObject({
      answering_user_public_id: "main",
      metadata_key: "opencode.bot",
      metadata_value: "personal",
    })

    const foreign = crypto.randomUUID()

    conversations.set(
      foreign,
      conversationFixture({
        public_id: foreign,
        answering_user_public_id: "someone-else",
        metadata: { "opencode.bot": "personal" },
      }),
    )
    await expect(
      bots.command({ action: "bot.resume", id: "personal", key: "foreign", workspace: "workspace", conversation: foreign }),
    ).rejects.toThrow("root conversation")

    const resumed = await bots.command({
      action: "bot.resume",
      id: "personal",
      key: "resume",
      workspace: "workspace",
      conversation: earlier,
    })

    expect(resumed).toMatchObject({ selected: { public_id: earlier, workspace_public_id: "workspace" } })
    expect(conversations.get(opened.selected.public_id)?.archived_at).toBeString()
  } finally {
    fixture.server.stop(true)
  }
})
