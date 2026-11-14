import { Cause, Effect, Semaphore } from "effect"
import type { Mcp } from "@opencode/core/mcp/index"
import type { McpRow } from "./mcp-settings"

/** One stdio reader at a time; HTTP requests keep their independent streams. */
export function mcpExchange(mcp: Pick<Mcp.Interface, "servers" | "connect" | "disconnect">, row: McpRow) {
  const lock = Semaphore.makeUnsafe(1)

  return async <A, E>(request: (onSessionRenewed: () => void) => Effect.Effect<A, E>, signal: AbortSignal) => {
    const notices: string[] = []
    const exchange = Effect.gen(function* () {
      const state = (yield* mcp.servers()).find((server) => server.name === row.server)

      if (row.transport !== "opencode" && state && ["failed", "disabled"].includes(state.status.status)) {
        yield* mcp.connect(row.server)
        notices.push(`note: mcp server ${row.key} was reconnected for this call; any state it held is gone`)
      }

      return yield* request(() => {
        notices.push(`note: mcp server ${row.key}'s session had expired and was re-established for this call`)
      }).pipe(
        Effect.onError((cause) => {
          // Poison the active pipe before releasing its permit; queued cancellations never enter here.
          return row.transport === "stdio" &&
            (Cause.hasInterrupts(cause) || /timeout|timed out/i.test(Cause.pretty(cause)))
            ? mcp.disconnect(row.server).pipe(Effect.ignore)
            : Effect.void
        }),
      )
    })

    const result = await Effect.runPromise(
      (row.transport === "stdio" ? exchange.pipe(lock.withPermit) : exchange).pipe(Effect.timeout(row.timeout)),
      { signal },
    )

    return { result, notice: notices.join("\n") }
  }
}
