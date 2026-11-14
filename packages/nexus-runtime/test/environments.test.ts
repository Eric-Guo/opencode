import { expect, test } from "bun:test"
import { Client, type StoreEntry } from "@cybros/agent"
import { mkdir, realpath, symlink } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Environments } from "../src/environments"
import { conversationFixture } from "./fixture/conversation"

function fixture(root: string, protectedRoots: string[] = []) {
  const entries = new Map<string, StoreEntry>()
  const locations = new Map<string, string>()
  const parents = new Map<string, string>()
  const control = { conflict: false, writes: 0 }
  const integrations: Array<{ anchor: string; root: string; entries: Schema.Json }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const segments = url.pathname.split("/")
      const conversation = segments[segments.indexOf("conversations") + 1]!
      const id = segments.at(-1)!
      if (url.pathname.includes("/executors/"))
        return Response.json({
          executor: {
            public_id: id,
            kind: "runner",
            status: "active",
            service_roles: ["runner"],
            presence: "connected",
            services: { runner: { tools: [], documents: [], environment: { root: "/remote/default" } } },
          },
        })
      if (url.pathname.endsWith("/conversations/" + conversation))
        return Response.json({
          conversation: conversationFixture({
            public_id: conversation,
            parent: parents.has(conversation)
              ? { public_id: parents.get(conversation)!, workspace_public_id: "workspace", relation: "fork" }
              : null,
            default_runner: { executor_public_id: "local", presence: "connected" },
          }),
        })
      if (request.method === "GET") {
        if (id === "store_entries")
          return Response.json({
            store_entries: [...entries.values()].filter((row) => locations.get(row.public_id) === conversation),
            pagination: { next_after: null },
          })
        const row = entries.get(id)
        return row
          ? Response.json({ store_entry: row })
          : Response.json({ error: { code: "not_found" } }, { status: 404 })
      }
      if (request.method === "DELETE") {
        const row = entries.get(id)
        if (row?.lock_version !== Number(url.searchParams.get("lock_version")))
          return Response.json({ error: { code: "stale_object" } }, { status: 409 })
        entries.delete(id)
        return new Response(null, { status: 204 })
      }
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          store_entry: Schema.Struct({
            namespace: Schema.optional(Schema.String),
            key: Schema.optional(Schema.String),
            value: Schema.MutableJson,
            lock_version: Schema.optional(Schema.Int),
          }),
        }),
      )(await request.json()).store_entry
      if (request.method === "POST") {
        if (
          [...entries.values()].some(
            (row) =>
              locations.get(row.public_id) === conversation && row.namespace === body.namespace && row.key === body.key,
          )
        )
          return Response.json({ error: { code: "key_taken" } }, { status: 409 })
        const created: StoreEntry = {
          public_id: crypto.randomUUID(),
          namespace: body.namespace!,
          key: body.key!,
          value: body.value,
          lock_version: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        entries.set(created.public_id, created)
        locations.set(created.public_id, conversation)
        control.writes++
        return Response.json({ store_entry: created }, { status: 201 })
      }
      const before = entries.get(id)!
      if (control.conflict) {
        control.conflict = false
        before.lock_version++
        return Response.json({ error: { code: "stale_object" } }, { status: 409 })
      }
      if (body.lock_version !== before.lock_version)
        return Response.json({ error: { code: "stale_object" } }, { status: 409 })
      const next = { ...before, value: body.value, lock_version: before.lock_version + 1 }
      entries.set(id, next)
      control.writes++
      return Response.json({ store_entry: next })
    },
  })
  const member = new Client({ baseURL: server.url.origin, credential: "test" })
  const environments = new Environments(member, { agent: "main", runner: "local", workspace: "workspace" })
  environments.configure({
    root: () => root,
    protectedRoots,
    mcp: async (_workspace, anchor, root, entries) => {
      integrations.push({ anchor, root, entries })
      return entries
    },
  })
  return { server, member, environments, parents, entries, locations, control, integrations }
}

test("environment records freeze root sets per runner, read fresh, and compare-and-swap a raced update", async () => {
  await using dir = await tmpdir()
  const root = await realpath(dir.path)
  await Promise.all([mkdir(join(root, "one")), mkdir(join(root, "two"))])
  const f = fixture(root)
  try {
    expect(await f.environments.read("workspace", "chat")).toMatchObject({ root, source: "default", anchor: null })
    const bound = await f.environments.bind("workspace", "chat", {
      root: join(root, "one"),
      directories: [join(root, "two")],
    })
    expect(bound).toMatchObject({
      root: join(root, "one"),
      directories: [join(root, "two")],
      anchor: "chat",
      source: "conversation",
      resolved: true,
    })
    const captured = await f.environments.capture("workspace", "chat", "local")
    f.control.conflict = true
    await f.environments.bind("workspace", "chat", { root: join(root, "two") })
    expect(captured).toEqual({
      "opencode.environment": { root: join(root, "one"), directories: [join(root, "two")], anchor: "chat" },
    })
    expect(await f.environments.capture("workspace", "chat", "local")).toMatchObject({
      "opencode.environment": { root: join(root, "two") },
    })
    expect(f.control.writes).toBe(2)
    await f.environments.bind(
      "workspace",
      "chat",
      { root: "/remote/project", directories: ["/remote/other"] },
      "remote",
    )
    expect(await f.environments.capture("workspace", "chat", "remote")).toEqual({
      "opencode.environment": { root: "/remote/project", directories: ["/remote/other"], anchor: "chat" },
    })
    await expect(f.environments.bind("workspace", "chat", { root: "relative" }, "remote")).rejects.toThrow(
      "absolute path",
    )
    const local = [...f.entries.values()].find((row) => row.key === "binding/local")!
    local.value = { root, directories: [], anchor: "changed-by-other-client" }
    expect(await f.environments.capture("workspace", "chat", "local")).toEqual({
      "opencode.environment": { root, directories: [], anchor: "changed-by-other-client" },
    })
    const restarted = new Environments(f.member, { agent: "main", runner: "local", workspace: "workspace" })
    expect(await restarted.capture("workspace", "chat", "local")).toEqual(
      await f.environments.capture("workspace", "chat", "local"),
    )
  } finally {
    f.server.stop(true)
  }
})

test("children inherit a durable copy with the parent anchor, while explicit child records win", async () => {
  await using dir = await tmpdir()
  const root = await realpath(dir.path)
  await mkdir(join(root, "child"))
  const f = fixture(root)
  f.parents.set("child", "parent")
  try {
    await f.environments.bind("workspace", "parent", { root })
    expect(await f.environments.read("workspace", "child")).toMatchObject({ root, source: "parent", anchor: "parent" })
    expect([...f.locations.values()]).toContain("child")
    await f.environments.bind("workspace", "parent", { root: join(root, "child") })
    expect(await f.environments.read("workspace", "child")).toMatchObject({ root, anchor: "parent" })
    await f.environments.bind("workspace", "child", { root: join(root, "child") })
    expect(await f.environments.read("workspace", "child")).toMatchObject({
      root: join(root, "child"),
      anchor: "child",
    })
    expect(await f.environments.list()).toHaveLength(2)
    const entry = [...f.entries.values()].find((row) => f.locations.get(row.public_id) === "child")!
    entry.value = { root: 42 }
    await expect(f.environments.capture("workspace", "child", "local")).rejects.toThrow()
  } finally {
    f.server.stop(true)
  }
})

test("ports remain ephemeral, typed clears retain unrelated fields, and protected symlinks are refused", async () => {
  await using dir = await tmpdir()
  const root = await realpath(dir.path)
  await Promise.all([mkdir(join(root, "protected")), mkdir(join(root, "other"))])
  await symlink(join(root, "protected"), join(root, "alias"))
  const f = fixture(root, [join(root, "protected")])
  const fs = {
    url: "http://127.0.0.1:12345",
    token: "private-bearer",
    session: "editor-id",
    client: "editor",
    read: true,
    write: false,
  }
  try {
    await expect(f.environments.bind("workspace", "chat", { fs })).rejects.toThrow("environment_unbound")
    await expect(f.environments.bind("workspace", "chat", { mcp: [{ name: "fixture" }] })).rejects.toThrow(
      "environment_unbound",
    )
    await f.environments.bind("workspace", "chat", { fs: null, mcp: [] })
    expect(f.entries.size).toBe(0)
    await expect(f.environments.bind("workspace", "chat", { root: "/remote", fs }, "remote")).rejects.toThrow(
      "runner_elsewhere",
    )
    await f.environments.bind("workspace", "chat", { root: null }, "remote")
    await expect(f.environments.bind("workspace", "chat", { root: join(root, "alias") })).rejects.toThrow(
      "protected root",
    )
    const initial = await f.environments.bind("workspace", "chat", {
      root,
      directories: [join(root, "other")],
      fs,
      mcp: [{ name: "fixture" }],
    })
    expect(initial.fs).toEqual({ client: "editor", read: true, write: false })
    const capture = await f.environments.capture("workspace", "chat", "local")
    expect(capture["opencode.environment"]).toMatchObject({ fs: { client: "editor", read: true, write: false } })
    expect(JSON.stringify(capture)).not.toContain("private-bearer")
    expect(JSON.stringify(capture)).not.toContain("12345")
    expect(JSON.stringify([...f.entries.values()])).not.toContain("private-bearer")
    const old = f.environments.port("workspace", "chat")!
    expect(old.session).toBe("editor-id")
    await f.environments.bind("workspace", "chat", { directories: [], fs: { ...fs, token: "replacement" } })
    f.environments.dropPort("workspace", "chat", old)
    expect(f.environments.port("workspace", "chat")?.token).toBe("replacement")
    expect((await f.environments.read("workspace", "chat")).mcp).toEqual([{ name: "fixture" }])
    await f.environments.bind("workspace", "chat", { fs: null, mcp: [] })
    expect(f.environments.port("workspace", "chat")).toBeUndefined()
    expect((await f.environments.read("workspace", "chat")).directories).toEqual([])
    await f.environments.bind("workspace", "chat", { root: null })
    expect(await f.environments.read("workspace", "chat")).toMatchObject({ root, source: "default" })
    expect(f.entries.size).toBe(0)
    await f.environments.bind("workspace", "chat", {
      root,
      fs: { url: "http://[::1]:12345", token: "private-bearer", client: "IPv6 editor" },
      mcp: [{ name: "fixture" }],
    })
    expect(f.environments.port("workspace", "chat")).toMatchObject({ read: false, write: false })
    await f.environments.release("workspace", "chat")
    expect(f.environments.port("workspace", "chat")).toBeUndefined()
    expect(f.integrations.at(-1)?.entries).toEqual([])
  } finally {
    f.server.stop(true)
  }
})
