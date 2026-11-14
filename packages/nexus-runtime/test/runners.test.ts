import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Runners } from "../src/runners"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture } from "./fixture/conversation"

test("selected runner survives restart, clears to own, and host changes preserve explicit null", async () => {
  await using dir = await tmpdir()
  const selected: Array<string | null> = []
  const declarations: string[][] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    const executor = (id: string) => ({
      public_id: id,
      kind: "runner",
      status: "active",
      service_roles: ["runner"],
      presence: "connected",
      services: {
        runner: { environment: { root: "/" + id }, tools: [{ name: "read", effect_profile: {} }], documents: [] },
      },
    })
    if (path.endsWith("/executors")) return Response.json({ executors: [executor("own"), executor("remote")] })
    if (path.endsWith("/executors/remote")) return Response.json({ executor: executor("remote") })
    if (path.endsWith("/conversations/chat"))
      return Response.json({
        conversation: conversationFixture({ default_runner: { executor_public_id: "own", presence: "connected" } }),
      })
    if (path.endsWith("/default_runner")) {
      const body = (await request.json()) as { default_runner: { executor_public_id: string | null } }
      selected.push(body.default_runner.executor_public_id)
      return Response.json({
        conversation: conversationFixture({
          default_runner: body.default_runner.executor_public_id
            ? { ...body.default_runner, presence: "connected" }
            : null,
        }),
      })
    }
    if (path.endsWith("/conversations") && request.method === "POST") {
      const body = (await request.json()) as { conversation: { default_runner_executor_public_id: string | null } }
      selected.push(body.conversation.default_runner_executor_public_id)
      return Response.json({ conversation: conversationFixture() }, { status: 201 })
    }
    if (path.includes("/store_entries")) return undefined
    return Response.json({ error: { code: "not_found" } }, { status: 404 })
  })
  const application = new NexusApplication(
    fixture.client,
    { agent: "main", workspace: "workspace", runner: "own" },
    () => ({}),
  )
  application.runners.configure({
    storage: join(dir.path, "runner.json"),
    hosts: () => [{ workspace: "workspace", conversation: "chat" }],
    refresh: async (ids) => {
      declarations.push(ids)
    },
  })
  try {
    expect(await application.runners.default()).toBe("own")
    const initial = await application.runners.list()
    expect(initial.selection).toBeNull()
    expect(initial.runners[0]).toMatchObject({
      own: true,
      selected: false,
      root: "/own",
      tools: ["read"],
      default_hosts: ["chat"],
    })
    await expect(application.runners.select("unknown")).rejects.toThrow("not a runner")
    await application.runners.select("remote")
    expect((await application.runners.list()).runners[1]?.selected).toBe(true)
    await application.open({ key: "new" })
    await application.open({ key: "none", runner: null })
    expect(selected).toEqual(["remote", null])
    const restarted = new Runners(fixture.client, "own")
    restarted.configure({ storage: join(dir.path, "runner.json") })
    expect(await restarted.default()).toBe("remote")
    expect(await application.runners.set("workspace", "chat", null)).toMatchObject({
      previous: "own",
      default_runner: null,
    })
    await application.runners.select(null)
    expect(await restarted.default()).toBe("own")
    expect(declarations.at(-1)).toEqual(["own", "remote"])
  } finally {
    fixture.server.stop(true)
  }
})
