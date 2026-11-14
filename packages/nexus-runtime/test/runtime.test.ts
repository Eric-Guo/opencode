import { expect, test } from "bun:test"
import type { OAuthDocument, Workspace } from "@cybros/agent"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NexusRuntime } from "../src/runtime"
import { atomic } from "../src/storage"

test.each([
  { name: "another agent's dedicated", dedicated: true, owned: false, create: false },
  { name: "another agent's archived dedicated", dedicated: true, owned: false, create: false, state: "archived" },
  { name: "this agent's dedicated", dedicated: true, owned: true, create: false },
  { name: "non-dedicated", dedicated: false, owned: false, create: false },
  { name: "automatically created", dedicated: true, owned: true, create: true },
])("validates $name workspace before reporting ready", async (fixture) => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-runtime-"))
  const runtime = new NexusRuntime(directory)
  const calls: { path: string; method: string; authorization: string | null; after: string | null; state: string }[] =
    []
  const measured = new Date().toISOString()
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
    fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      calls.push({
        path,
        method: request.method,
        authorization: request.headers.get("authorization"),
        after: url.searchParams.get("after"),
        state: runtime.status().state,
      })

      if (path === "/agent_api/v1/executor/announcement")
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
      if (path === "/agent_api/v1/tools") return Response.json({ tools: [] })
      if (path === "/agent_api/v1/executors") return Response.json({ executors: [] })
      if (path === "/agent_api/v1/profile/configuration")
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
      if (path === "/agent_api/v1/executor/inbox") return Response.json({ tasks: [], pagination: { next_after: null } })

      return new Response(null, { status: 404 })
    },
  })
  try {
    await atomic(join(directory, "settings.json"), {
      origin: nexus.url.origin,
      identifier: "opencode.fixture",
      directory,
      workspace: fixture.create ? "" : "workspace",
      model: "model",
    })
    const credentials: OAuthDocument = {
      version: 2,
      authentication_kind: "oauth",
      connection: "fixture",
      rotation: 0,
      refresh_token: "fixture-refresh",
      access_token: "fixture-member",
      executor_access_token: "fixture-executor",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }
    await atomic(join(directory, "agent.json"), credentials)
    await runtime.restore()

    const deadline = Date.now() + 3000
    while (runtime.status().state === "connecting" && Date.now() < deadline) await Bun.sleep(1)

    const ready = !fixture.dedicated || fixture.owned
    expect(runtime.status().state).toBe(ready ? "ready" : "error")
    if (ready) {
      expect(runtime.status().identity).toMatchObject({ agent: "agent", workspace: "workspace" })
      expect(runtime.status().error).toBeUndefined()
      expect(runtime.status().executor).toMatchObject({
        running: true,
        claimed: 0,
        nudged: 0,
        canceled: 0,
        in_flight: 0,
        starting: 0,
      })
    } else {
      expect(runtime.status().identity).toBeUndefined()
      expect(runtime.status().error).toBe(
        'Nexus workspace "Workspace" is dedicated to another agent. Disconnect and pair OpenCode with a different workspace, or leave Workspace ID blank to create one.',
      )
      expect(calls.some((call) => call.path === "/agent_api/v1/profile/configuration")).toBe(false)
      expect(calls.some((call) => call.path === "/agent_api/v1/executor/inbox")).toBe(false)
      expect(() => runtime.runners()).toThrow("Nexus is disconnected.")
    }

    expect(calls.filter((call) => call.path === "/agent_api/v1/workspaces" && call.method === "GET")).toEqual(
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
