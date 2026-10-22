import { expect, test } from "bun:test"
import { join } from "node:path"
import { serviceFixture } from "../../../../client/test/fixture/service-fixture"
import { createProxySettings } from "../proxy-settings"
import { getProxyEnvironment } from "../proxy"
import { openDatabase } from "../storage/database"
import { createStateStore } from "../storage/state"
import { ensureProxyService } from "./proxy"

test("a changed launch replaces the local service once and reconnects keep the running configuration", async () => {
  await using fixture = await serviceFixture()
  const database = openDatabase(":memory:")
  const state = createStateStore(database.db)
  const previous = fixture.spawn("handoff")
  await fixture.waitForFile()

  try {
    createProxySettings(state).set({ mode: "manual", url: "http://proxy.test:7890", bypass: "" })
    const proxy = createProxySettings(state)
    const wrapper = join(fixture.directory, "proxy-service.ts")
    await Bun.write(
      wrapper,
      `await Bun.write(process.argv[2] + '.proxy', JSON.stringify({http: process.env.HTTP_PROXY, https: process.env.https_proxy, no: process.env.NO_PROXY})); await import(${JSON.stringify(fixture.command("environment")[1])});`,
    )

    const options = {
      file: fixture.registration,
      version: "test",
      command: [process.execPath, wrapper, fixture.registration, "environment"],
      env: getProxyEnvironment(proxy.active, {}),
    }

    const service = await ensureProxyService(proxy, options, "initial")
    const info = await Bun.file(fixture.registration).json()
    fixture.track(info.pid)
    expect(info.pid).not.toBe(previous.pid)
    expect(proxy.pending()).toBe(false)
    expect(await Bun.file(fixture.registration + ".proxy").json()).toEqual({
      http: "http://proxy.test:7890",
      https: "http://proxy.test:7890",
      no: "127.0.0.1,localhost,::1,[::1]",
    })
    expect(await Bun.file(fixture.registration + ".handoff").json()).not.toBeNull()
    proxy.set({ mode: "direct" })
    expect(await ensureProxyService(proxy, options, "reconnect")).toEqual(service)
    expect((await Bun.file(fixture.registration).json()).pid).toBe(info.pid)
    expect(proxy.get().restartRequired).toBe(true)
    // A failed replacement must leave the durable pending change available for the next launch.
    const next = createProxySettings(state)
    await expect(ensureProxyService(next, { ...options, command: [] }, "initial")).rejects.toThrow()
    expect(next.pending()).toBe(true)
  } finally {
    state.close()
    database.close()
  }
}, 30_000)
