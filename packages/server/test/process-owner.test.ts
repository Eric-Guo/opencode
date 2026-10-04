import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { DatabaseProcessOwner } from "@opencode/core/database/process-owner"
import { Global } from "@opencode/util/global"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServerProcess } from "../src/process"

test("database conflict rejects managed and standalone startup before registration or migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-server-owner-"))
  const file = join(root, "session.db")
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(
      DatabaseProcessOwner.acquire(file).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Global.Service, Global.make()),
      ),
    )
    let registered = false
    const options = { password: "fixture", port: 0, database: { path: file }, models: { fetch: false } }
    await expect(Effect.runPromise(Effect.scoped(ServerProcess.start(options)))).rejects.toThrow(
      "Another server owns this database",
    )
    await expect(
      Effect.runPromise(
        Effect.scoped(
          ServerProcess.start(options, {
            onListen: () =>
              Effect.sync(() => {
                registered = true
                return Effect.void
              }),
          }),
        ),
      ),
    ).rejects.toThrow("Another server owns this database")
    expect(registered).toBe(false)
    expect(await Bun.file(file).exists()).toBe(false)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed registration releases the listener and ownership before its caller retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-server-owner-failed-start-"))
  const file = join(root, "session.db")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let port = 0
          const exit = yield* ServerProcess.start(
            { password: "fixture", port: 0, database: { path: file } },
            {
              onListen: (address) => {
                if (address._tag === "TcpAddress") port = address.port
                return Effect.fail(new Error("fixture registration failure"))
              },
            },
          ).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          yield* DatabaseProcessOwner.acquire(file).pipe(Effect.provideService(Global.Service, Global.make()))
          const listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() })
          listener.stop(true)
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
