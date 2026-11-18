import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { conversationMemory } from "../src/memory-commands"
import { storeFixture } from "./fixture/store"

test.each(["same binding", "changed binding"])("conversation memory first write with %s", async (mode) => {
  const path = "speaker/notes.md"
  const measured = "2026-11-18T00:00:00Z"
  const requests: string[] = []
  const writes: JsonObject[] = []
  const creations: JsonObject[] = []
  const document = {
    path,
    public_id: "note",
    collection_public_id: "collection",
    lock_version: 4,
    bytesize: 10,
    content: "first\nnote",
    written_at: measured,
  }
  const state = { allocated: false, written: false }
  const fixture = storeFixture(async (request) => {
    const url = new URL(request.url)
    const route = url.pathname.replace(/^.*\/agent_api\/v1/, "")
    requests.push(request.method + " " + route)

    if (route.endsWith("/memory/show"))
      return state.written
        ? Response.json({ memory: document })
        : Response.json({ error: { code: "memory_scope_unavailable" } }, { status: 422 })

    if (route.endsWith("/memory") && request.method === "GET") {
      expect(url.searchParams.get("memory[speaker_public_id]")).toBe("requester")
      return Response.json({
        memory: state.written ? [document] : [],
        memory_context: {
          bindings: [
            {
              name: "speaker",
              source: { scope: "speaker" },
              scope: "speaker",
              access: "read_write",
              collection_public_id: state.allocated ? "collection" : null,
              owner_public_id: "bot",
              speaker_public_id: state.allocated && mode === "changed binding" ? "other" : "requester",
              state: state.allocated ? "active" : "unallocated",
            },
          ],
        },
      })
    }
    if (route === "/profile")
      return Response.json({
        member: { public_id: "main", handle: "main", kind: "agent", role: "member" },
        credential: { plane: "member", expires_at: null },
        measured_at: measured,
      })
    if (route === "/profile/agents")
      return Response.json({
        agents: [
          {
            public_id: "bot",
            name: "bot-fixture",
            scope: "application",
            handle: "bot-fixture",
            description: "Fixture Bot",
            agent_identifier: "fixture",
            steward_public_id: "owner",
            kind: "agent",
            derived_from_public_id: "main",
            configuration: {
              tool_definitions: [],
              kernel_tools: [],
              runner_executor_public_ids: [],
              mcp_tools: [],
              fallback_models: [],
            },
          },
        ],
      })
    if (route === "/profile/agents/bot-fixture/memory_collections") {
      creations.push((await request.json()) as JsonObject)
      state.allocated = true

      return Response.json(
        {
          memory_collection: {
            public_id: "collection",
            name: null,
            description: null,
            scope: "speaker",
            owner_public_id: "bot",
            speaker_public_id: "requester",
            is_default: true,
            archived_at: null,
            lock_version: 0,
            created_at: measured,
            updated_at: measured,
            writable: true,
            manageable: true,
          },
        },
        { status: 201 },
      )
    }
    if (route.endsWith("/memory/grep"))
      return Response.json({ matches: [{ path, line_number: 2, text: "note" }], truncated: true })

    const body = (await request.json()) as { memory: JsonObject }
    writes.push(body.memory)

    if (route.endsWith("/memory/edit")) return Response.json({ error: { code: "stale_object" } }, { status: 409 })
    if (route.endsWith("/memory/delete")) return new Response(null, { status: 204 })

    state.written = true
    return Response.json({ memory: document }, { status: 201 })
  })
  const run = (command: string) =>
    conversationMemory(fixture.client, {
      workspace: "workspace",
      conversation: "conversation",
      speaker: "requester",
      command,
    })

  try {
    expect((await run("ls")).value).toEqual([])
    await expect(run("delete " + path)).rejects.toMatchObject({ status: 422, code: "memory_scope_unavailable" })
    expect(creations).toEqual([])
    expect(writes).toEqual([])

    const pending = run("write " + path + " first\nnote")
    if (mode === "changed binding") {
      await expect(pending).rejects.toThrow("binding changed")
      expect(writes).toEqual([])
      return
    }
    expect((await pending).text).toBe("Write completed: " + path)
    expect(creations).toEqual([{ memory_collection: { default: true, speaker_public_id: "requester" } }])
    expect(writes).toEqual([
      {
        path,
        content: "first\nnote",
        speaker_public_id: "requester",
        expected_collection_public_id: "collection",
        expected_public_id: null,
        expected_lock_version: null,
      },
    ])
    expect((await run("grep note")).text).toBe(path + ":2: note\nMore matches exist; narrow the pattern.")
    expect((await run("read " + path)).text).toBe(path + "\nfirst\nnote")
    await expect(run('edit {"path":"speaker/notes.md","old_text":"first\\nnote","new_text":""}')).rejects.toMatchObject(
      {
        status: 409,
        code: "stale_object",
      },
    )
    expect((await run("delete " + path)).value).toEqual({ path })
    expect(writes.slice(1)).toEqual([
      {
        path,
        old_text: "first\nnote",
        new_text: "",
        speaker_public_id: "requester",
        expected_collection_public_id: "collection",
        expected_public_id: "note",
        expected_lock_version: 4,
      },
      {
        path,
        speaker_public_id: "requester",
        expected_collection_public_id: "collection",
        expected_public_id: "note",
        expected_lock_version: 4,
      },
    ])
    expect(requests.filter((request) => request.endsWith("/memory/edit"))).toHaveLength(1)
  } finally {
    fixture.server.stop(true)
  }
})
