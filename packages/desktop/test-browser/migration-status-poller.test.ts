import { expect, test } from "bun:test"
import { OpenCode, type MigrationV1StatusOutput } from "@opencode/client/promise"
import { createRoot, createSignal } from "solid-js"
import { createMigrationStatusPoller } from "../src/renderer/migration-status-poller"

test("migration polling cancels the old request and resumes at the new endpoint", async () => {
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Response>()
  const completed = Promise.withResolvers<void>()
  const requests: string[] = []
  const signals: AbortSignal[] = []
  const statuses: MigrationV1StatusOutput[] = []
  const errors: unknown[] = []
  const servers = ["old", "new"].map((name) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.url)
        if (name === "new") return Response.json({ status: "completed" })
        started.resolve()
        return pending.promise
      },
    }),
  )
  const endpoint = { url: servers[0]!.url.origin }
  const client = OpenCode.make({
    get baseUrl() {
      return endpoint.url
    },
  })
  const poller = createRoot((dispose) => {
    const [connected, setConnected] = createSignal(true)
    createMigrationStatusPoller({
      connected,
      status(signal) {
        signals.push(signal)
        return client.migration.v1.status({ signal })
      },
      onStatus(status) {
        statuses.push(status)
        completed.resolve()
      },
      onError: (error) => errors.push(error),
      onCleanup() {},
    })
    return { dispose, setConnected }
  })

  try {
    await started.promise
    poller.setConnected(false)
    expect(signals[0]?.aborted).toBe(true)
    pending.resolve(Response.json({ status: "error", error: "obsolete server" }))
    endpoint.url = servers[1]!.url.origin
    poller.setConnected(true)
    await completed.promise

    expect(requests).toEqual(servers.map((server) => `${server.url.origin}/api/experimental/migration/v1`))
    expect(statuses).toEqual([{ status: "completed" }])
    expect(errors).toEqual([])
  } finally {
    poller.dispose()
    pending.resolve(Response.json({ status: "completed" }))
    servers.forEach((server) => server.stop(true))
  }
})

test("migration polling waits for connection and cancels its startup delay on disconnect", async () => {
  const requests: AbortSignal[] = []
  const poller = createRoot((dispose) => {
    const [connected, setConnected] = createSignal(false)
    createMigrationStatusPoller({
      connected,
      async status(signal) {
        requests.push(signal)
        return { status: "completed" }
      },
      onStatus() {},
      onError() {},
      onCleanup() {},
    })
    return { dispose, setConnected }
  })

  try {
    await Bun.sleep(1_100)
    expect(requests).toEqual([])
    poller.setConnected(true)
    poller.setConnected(false)
    await Bun.sleep(1_100)
    expect(requests).toEqual([])
  } finally {
    poller.dispose()
  }
})

test("migration failures from the connected server are reported", async () => {
  const failed = Promise.withResolvers<unknown>()
  const statuses: MigrationV1StatusOutput[] = []
  const dispose = createRoot((dispose) => {
    createMigrationStatusPoller({
      connected: () => true,
      status: async () => ({ status: "error", error: "migration failed" }),
      onStatus: (status) => statuses.push(status),
      onError: failed.resolve,
      onCleanup() {},
    })
    return dispose
  })

  try {
    expect(await failed.promise).toEqual(new Error("migration failed"))
    expect(statuses).toEqual([{ status: "error", error: "migration failed" }])
  } finally {
    dispose()
  }
})
