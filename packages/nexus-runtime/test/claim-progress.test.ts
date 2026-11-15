import { afterEach, expect, jest, test } from "bun:test"
import { claimProgress } from "../src/claim-progress"

afterEach(() => jest.useRealTimers())

test.each([false, true])("claim progress coalesces a burst and cancels pending publication: %s", async (cancel) => {
  jest.useFakeTimers()
  const received: string[] = []
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<void>()
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "GET") return Response.json(received)
      received.push(await request.text())
      if (received.length === 1) {
        started.resolve()
        await released.promise
      }
      return new Response(null, { status: 202 })
    },
  })
  const controller = new AbortController()
  const write = claimProgress(async (text) => {
    const response = await fetch(server.url, { method: "POST", body: text, signal: controller.signal })
    await response.text()
    sent.resolve()
  }, controller.signal)
  const first = write("first")
  await started.promise
  const second = write("intermediate")
  const last = write("latest")
  released.resolve()
  await sent.promise
  // A real round trip lets the preceding HTTP completion register its cadence timer.
  expect(await fetch(server.url).then((response) => response.json())).toEqual(["first"])
  if (cancel) controller.abort()
  if (!cancel) {
    jest.advanceTimersByTime(249)
    expect(received).toEqual(["first"])
    jest.advanceTimersByTime(1)
  }
  await Promise.all([first, second, last])
  expect(received).toEqual(cancel ? ["first"] : ["first", "latest"])
})

test("a refused progress publication stops future frames without failing the tool", async () => {
  const received: string[] = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push(await request.text())
      return new Response(null, { status: 409 })
    },
  })
  const write = claimProgress(async (text) => {
    const response = await fetch(server.url, { method: "POST", body: text })
    if (!response.ok) throw new Error("Claim no longer owns progress")
  }, new AbortController().signal)
  await write("first")
  await write("later")
  expect(received).toEqual(["first"])
})
