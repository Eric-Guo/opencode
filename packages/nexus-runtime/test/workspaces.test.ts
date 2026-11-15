import { expect, test } from "bun:test"
import { Client } from "@cybros/agent"
import { Workspaces } from "../src/workspaces"

test("workspace selection paginates active owned and shared workspaces and rejects foreign dedication", async () => {
  const paths: string[] = []

  const row = (id: string, dedicated = true, state = "active") => ({
    public_id: id,
    name: id,
    access_mode: "private",
    state,
    dedicated,
    lock_version: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  })

  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      paths.push(url.pathname + url.search)

      if (url.pathname === "/agent_api/v1/workspaces") {
        const owned = url.searchParams.get("dedicated_to_current_agent") === "true"
        const after = url.searchParams.get("after")

        return Response.json({
          workspaces: owned
            ? after
              ? [row("second")]
              : [row("owned"), row("archived", true, "archived")]
            : [row("shared", false)],
          pagination: { next_after: owned && !after ? "next" : null },
        })
      }

      const id = url.pathname.split("/").at(-1)!

      return Response.json({
        workspace: {
          ...row(id, id !== "shared", id === "archived" ? "archived" : "active"),
          metadata: {},
          tool_provider_overrides: {},
          owner: { public_id: "human", display_name: "Human" },
          creator: { public_id: "agent", display_name: "Agent", kind: "agent" },
        },
      })
    },
  })

  const workspaces = new Workspaces(new Client({ baseURL: server.url.origin, credential: "fixture" }))
  expect((await workspaces.list()).map((row) => row.public_id)).toEqual(["owned", "second", "shared"])
  expect((await workspaces.require("second")).public_id).toBe("second")
  expect((await workspaces.require("shared")).public_id).toBe("shared")
  await expect(workspaces.require("foreign")).rejects.toThrow("active workspace")
  await expect(workspaces.require("archived")).rejects.toThrow("active workspace")
  expect(paths.some((path) => path.includes("after=next"))).toBe(true)
})
