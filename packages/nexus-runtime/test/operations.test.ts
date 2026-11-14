import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { register } from "../dev/extension"
import descriptor from "../dev/extension.json"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

test("development controls use the connected application, exact run identities and the agent ownership boundary", async () => {
  const requests: { path: string; method: string; body?: unknown }[] = []
  const directory = await mkdtemp(join(tmpdir(), "nexus-dev-"))
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    requests.push({ path, method: request.method, body: request.body ? await request.json() : undefined })

    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ active_turn_public_id: "new-turn" }) })
    if (path.endsWith("/conversations/foreign"))
      return Response.json({ conversation: conversationFixture({ answering_user_public_id: "other" }) })
    if (path.endsWith("/runs/old") || path.endsWith("/runs/foreign") || path.endsWith("/runs/old/stop"))
      return Response.json({
        run: {
          public_id: path.includes("/foreign") ? "foreign" : "old",
          status: request.method === "GET" ? "running" : "stopped",
          turn: { status: "running", conversation_public_id: path.includes("/foreign") ? "foreign" : "conversation" },
        },
      })
    if (path.endsWith("/inputs/queued") && request.method === "PATCH")
      return Response.json({ input: inputFixture({ public_id: "queued", text: "corrected", lock_version: 3 }) })
    return Response.json({ error: { code: "unexpected_request" } }, { status: 400 })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory, "config.json")),
    [{ descriptor, register }],
    directory,
    new AbortController().signal,
    async () => {},
    () => application,
  )

  try {
    await expect(manager.command("dev", { action: "run.stop", run: "old" })).rejects.toThrow("not loaded")
    await manager.start()
    expect(manager.list()[0]).toMatchObject({ active: true, ready: true, tools: [] })
    expect(await manager.command("dev", { action: "run.stop", run: "old", force: true })).toMatchObject({
      public_id: "old",
      status: "stopped",
    })
    expect(requests.filter((request) => request.method !== "GET")).toEqual([
      { path: "/agent_api/v1/workspaces/workspace/runs/old/stop", method: "POST", body: { force: true } },
    ])

    await expect(manager.command("dev", { action: "run.stop", run: "foreign" })).rejects.toThrow("another agent")
    await expect(manager.command("dev", { action: "stop", conversation: "foreign" })).rejects.toThrow("another agent")
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1)

    await manager.command("dev", {
      action: "input.edit",
      conversation: "conversation",
      input: "queued",
      version: 2,
      text: "corrected",
      delivery: "queue",
    })
    expect(requests.at(-1)?.body).toEqual({
      input: { expected_lock_version: 2, text: "corrected", delivery_mode: "queue" },
    })
    await expect(
      manager.command("dev", { action: "regenerate", conversation: "conversation", turn: "turn" }),
    ).rejects.toThrow()
  } finally {
    await manager.close()
    fixture.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("shared submissions capture the current surface policy and retain it on retry", async () => {
  const submitted: JsonObject[] = []
  const policy = { calls: 0 }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname

    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      submitted.push(body.input)
      return Response.json({ input: inputFixture(body.input) }, { status: 202 })
    }
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "local" },
    () => ({}),
    undefined,
    async () => {
      policy.calls++
      return {
        model: "model",
        fallback_models: [],
        agent_configuration: {},
        tools: ["read"],
        executor_contexts: { remote: { "opencode.directory": "/remote/project" } },
      }
    },
  )

  try {
    const command = { action: "say", conversation: "conversation", key: "one-input", text: "Read the project" }

    await application.operations.command(command)
    await application.operations.command(command)
    expect(policy.calls).toBe(1)
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual(submitted[0])
    expect(submitted[0]).toMatchObject({
      tool_names: ["read"],
      executor_contexts: { remote: { "opencode.directory": "/remote/project" } },
    })
  } finally {
    fixture.server.stop(true)
  }
})
