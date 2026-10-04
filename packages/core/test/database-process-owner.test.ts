import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { Global } from "@opencode/util/global"
import { mkdtemp, readlink, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseProcessOwner } from "../src/database/process-owner"

test("database ownership survives rejected contenders and lasts until its scope closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-"))
  const layer = Global.layerWith({ data: root })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const scope = await Effect.runPromise(Scope.make())
  const acquire = (file: string) => DatabaseProcessOwner.acquire(file).pipe(Effect.provideService(Scope.Scope, scope))
  try {
    expect(await run(acquire("session.db"))).toBe(join(root, "session.db"))
    await expect(run(Effect.scoped(DatabaseProcessOwner.acquire(join(root, "session.db"))))).rejects.toThrow(
      "Another server owns this database",
    )
    await expect(run(Effect.scoped(DatabaseProcessOwner.acquire(join(root, "session.db"))))).rejects.toThrow(
      "Another server owns this database",
    )
    await run(Effect.scoped(DatabaseProcessOwner.acquire(join(root, "independent.db"))))
    await run(Effect.scoped(DatabaseProcessOwner.acquire(":memory:")))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await run(Effect.scoped(DatabaseProcessOwner.acquire(join(root, "session.db"))))
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "linux" || !Bun.which("unshare"))(
  "different PID/network namespaces share the lease and SIGKILL releases it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-namespace-"))
    const file = join(root, "session.db")
    const child = Bun.spawn(
      [
        "unshare",
        "-Urnpf",
        "--mount-proc",
        "--kill-child",
        process.execPath,
        join(import.meta.dir, "fixture/database-owner.ts"),
        file,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const acquire = () =>
      Effect.runPromise(
        Effect.scoped(DatabaseProcessOwner.acquire(file)).pipe(Effect.provideService(Global.Service, Global.make())),
      )
    try {
      const reader = child.stdout.getReader()
      const ready = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => {
          throw new Error("Namespace fixture did not become ready")
        }),
      ])
      const info = JSON.parse(new TextDecoder().decode(ready.value))
      expect(info.namespaces[0]).not.toBe(await readlink("/proc/self/ns/pid"))
      expect(info.namespaces[1]).not.toBe(await readlink("/proc/self/ns/net"))
      await expect(acquire()).rejects.toThrow("Another server owns this database")
      child.kill("SIGKILL")
      await child.exited
      const deadline = Date.now() + 3_000
      while (true) {
        try {
          await acquire()
          break
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await Bun.sleep(25)
        }
      }
    } finally {
      child.kill("SIGKILL")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  },
  10_000,
)

test.skipIf(process.platform !== "linux" || !Bun.which("node"))(
  "Node and Bun runtime adapters contend for the same database lease",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-node-"))
    const output = await Bun.build({
      entrypoints: [join(import.meta.dir, "fixture/database-owner.ts")],
      target: "node",
      outdir: root,
      naming: "owner.mjs",
    })
    expect(output.success).toBe(true)
    const child = Bun.spawn([Bun.which("node")!, join(root, "owner.mjs"), join(root, "session.db")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const acquire = () =>
      Effect.runPromise(
        Effect.scoped(DatabaseProcessOwner.acquire(join(root, "session.db"))).pipe(
          Effect.provideService(Global.Service, Global.make()),
        ),
      )
    try {
      const reader = child.stdout.getReader()
      const ready = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => {
          throw new Error("Node fixture did not become ready")
        }),
      ])
      expect(JSON.parse(new TextDecoder().decode(ready.value)).pid).toBe(child.pid)
      await expect(acquire()).rejects.toThrow("Another server owns this database")
      child.kill("SIGTERM")
      await child.exited
      await acquire()
    } finally {
      child.kill("SIGKILL")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  },
  10_000,
)

test("directory symlinks and relative paths cannot bypass database ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-alias-"))
  const scope = await Effect.runPromise(Scope.make())
  const layer = Global.layerWith({ data: root })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  try {
    await symlink(root, join(root, "alias"), "dir")
    await run(DatabaseProcessOwner.acquire("session.db").pipe(Effect.provideService(Scope.Scope, scope)))
    await expect(run(Effect.scoped(DatabaseProcessOwner.acquire(join(root, "alias", "session.db"))))).rejects.toThrow(
      "Another server owns this database",
    )
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
})

test("ownership is retained while later shutdown finalizers are still draining", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-drain-"))
  const scope = await Effect.runPromise(Scope.make())
  const finish = Promise.withResolvers<void>()
  const draining = Promise.withResolvers<void>()
  const acquire = () =>
    DatabaseProcessOwner.acquire(join(root, "session.db")).pipe(Effect.provideService(Global.Service, Global.make()))
  try {
    await Effect.runPromise(acquire().pipe(Effect.provideService(Scope.Scope, scope)))
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.promise(() => {
          draining.resolve()
          return finish.promise
        }),
      ),
    )
    const closing = Effect.runPromise(Scope.close(scope, Exit.void))
    await draining.promise
    await expect(Effect.runPromise(Effect.scoped(acquire()))).rejects.toThrow("Another server owns this database")
    finish.resolve()
    await closing
    await Effect.runPromise(Effect.scoped(acquire()))
  } finally {
    finish.resolve()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
})
