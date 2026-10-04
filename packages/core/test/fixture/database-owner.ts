import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { readlink } from "node:fs/promises"
import { DatabaseProcessOwner } from "../../src/database/process-owner"

const keepAlive = setInterval(() => {}, 60_000)
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
).finally(() => clearInterval(keepAlive))
