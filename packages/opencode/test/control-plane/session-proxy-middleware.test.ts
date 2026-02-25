import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { tmpdir } from "../fixture/fixture"
import { Project } from "../../src/project/project"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  mock.restore()
  await resetDatabase()
})

type State = {
  workspaceID: string
  calls: Array<{ method: string; url: string; body?: string }>
}

const remote = { type: "testing", name: "remote-a" } as unknown as typeof WorkspaceTable.$inferInsert.config

async function setup(state: State) {
  mock.module("../../src/control-plane/adaptors", () => ({
    getAdaptor: () => ({
      request: async (_config: unknown, method: string, url: string, data?: BodyInit) => {
        const body = data ? await new Response(data).text() : undefined
        state.calls.push({ method, url, body })
        return new Response("proxied", { status: 202 })
      },
    }),
  }))

  await using tmp = await tmpdir({ git: true })
  const { project } = await Project.fromDirectory(tmp.path)

  Database.use((db) => {
    db.delete(WorkspaceTable).run()
  })
  Database.use((db) =>
    db
      .insert(WorkspaceTable)
      .values([
        {
          id: "wrk_1",
          branch: "main",
          project_id: project.id,
          config: remote,
        },
        {
          id: "wrk_2",
          branch: "main",
          project_id: project.id,
          config: { type: "worktree", directory: tmp.path },
        },
      ])
      .run(),
  )

  const { SessionProxyMiddleware } = await import("../../src/control-plane/session-proxy-middleware")
  const app = new Hono().use(SessionProxyMiddleware)

  return {
    app,
    async request(input: RequestInfo | URL, init?: RequestInit) {
      return Instance.provide({
        directory: state.workspaceID,
        fn: async () => app.request(input, init),
      })
    },
  }
}

describe("control-plane/session-proxy-middleware", () => {
  test("forwards non-GET session requests for remote workspaces", async () => {
    const state: State = {
      workspaceID: "wrk_1",
      calls: [],
    }

    const ctx = await setup(state)

    ctx.app.post("/session/foo", (c) => c.text("local", 200))
    const response = await ctx.request("http://workspace.test/session/foo?x=1", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: {
        "content-type": "application/json",
      },
    })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe("proxied")
    expect(state.calls).toEqual([
      {
        method: "POST",
        url: "/session/foo?x=1",
        body: '{"hello":"world"}',
      },
    ])
  })

  test("does not forward GET requests", async () => {
    const state: State = {
      workspaceID: "wrk_1",
      calls: [],
    }

    const ctx = await setup(state)

    ctx.app.get("/session/foo", (c) => c.text("local", 200))
    const response = await ctx.request("http://workspace.test/session/foo?x=1")

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("local")
    expect(state.calls).toEqual([])
  })

  test("does not forward GET or POST requests for worktree workspaces", async () => {
    const state: State = {
      workspaceID: "wrk_2",
      calls: [],
    }

    const ctx = await setup(state)

    ctx.app.get("/session/foo", (c) => c.text("local-get", 200))
    ctx.app.post("/session/foo", (c) => c.text("local-post", 200))

    const getResponse = await ctx.request("http://workspace.test/session/foo?x=1")
    const postResponse = await ctx.request("http://workspace.test/session/foo?x=1", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: {
        "content-type": "application/json",
      },
    })

    expect(getResponse.status).toBe(200)
    expect(await getResponse.text()).toBe("local-get")
    expect(postResponse.status).toBe(200)
    expect(await postResponse.text()).toBe("local-post")
    expect(state.calls).toEqual([])
  })
})
