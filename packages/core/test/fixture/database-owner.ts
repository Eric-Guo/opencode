import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { readlink } from "node:fs/promises"
import { DatabaseProcessOwner } from "../../src/database/process-owner"

const keepAlive = setInterval(() => {}, 60_000)
const controller = new AbortController()
process.stdin.on("data", (data) => {
  if (String(data).includes("crash")) process.kill(process.pid, "SIGKILL")
  if (String(data).includes("stop")) controller.abort()
})
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* DatabaseProcessOwner.acquire(process.argv[2])
      const namespaces = yield* Effect.promise(() =>
        Promise.all([readlink("/proc/self/ns/pid"), readlink("/proc/self/ns/net")]),
      )
      console.log(JSON.stringify({ pid: process.pid, namespaces }))
      yield* Effect.never
    }),
  ).pipe(Effect.provideService(Global.Service, Global.make())),
  { signal: controller.signal },
)
  .catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })
  .finally(() => {
    clearInterval(keepAlive)
    process.stdin.pause()
  })
