import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mcpExchange } from "../src/mcp-exchange"
import { mcpSettings } from "../src/mcp-settings"

test("stdio MCP serializes requests, leaves queued cancellation isolated, and poisons before releasing the reader", async () => {
  const row = mcpSettings({ local: { transport: "stdio", command: "peer", tools: ["*"] } }, "/project").rows[0]
  const entered = Promise.withResolvers<void>()
  const disconnecting = Promise.withResolvers<void>()
  const disconnected = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const events: string[] = []
  const exchange = mcpExchange(
    {
      servers: () => Effect.succeed([]),
      connect: () => Effect.void,
      disconnect: () =>
        Effect.promise(async () => {
          events.push("disconnect")
          disconnecting.resolve()
          await disconnected.promise
        }),
    },
    row,
  )
  const active = new AbortController()
  const queued = new AbortController()
  const first = exchange(
    () =>
      Effect.promise(async () => {
        events.push("first")
        entered.resolve()
        await blocked.promise
      }),
    active.signal,
  ).catch((error: unknown) => error)

  try {
    await entered.promise
    const second = exchange(() => Effect.sync(() => events.push("second")), queued.signal).catch(
      (error: unknown) => error,
    )

    queued.abort()
    await second
    expect(events).toEqual(["first"])
    active.abort()
    await disconnecting.promise
    const third = exchange(() => Effect.sync(() => events.push("third")), new AbortController().signal)

    await Effect.runPromise(Effect.yieldNow)
    expect(events).toEqual(["first", "disconnect"])
    disconnected.resolve()
    await first
    await third
    expect(events).toEqual(["first", "disconnect", "third"])
  } finally {
    active.abort()
    queued.abort()
    blocked.resolve()
    disconnected.resolve()
    await first
  }
})
