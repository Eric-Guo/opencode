import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { Global } from "@opencode/util/global"
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseProcessOwner } from "../src/database/process-owner"

test.skipIf(process.platform !== "linux")(
  "incomplete ownership and abandoned recovery markers never expire automatically",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-incomplete-"))
    const file = join(root, "session.db")
    const acquire = () =>
      Effect.runPromise(
        Effect.scoped(DatabaseProcessOwner.acquire(file)).pipe(Effect.provideService(Global.Service, Global.make())),
      )
    try {
      await mkdir(file + ".owner")
      await expect(acquire()).rejects.toThrow("incomplete or unreadable")
      await rm(file + ".owner", { recursive: true })
      await mkdir(file + ".owner.recover")
      await expect(acquire()).rejects.toThrow("needs manual verification")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "simultaneous same-domain crash successors cannot remove the winning owner",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-database-owner-recovery-race-"))
    const file = join(root, "session.db")
    const spawn = () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "fixture/database-owner.ts"), file], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
    const previous = spawn()
    const contenders: ReturnType<typeof spawn>[] = []
    try {
      await previous.stdout.getReader().read()
      previous.kill("SIGKILL")
      await previous.exited
      contenders.push(spawn(), spawn(), spawn())
      const results = await Promise.all(
        contenders.map(async (child) => {
          const first = await child.stdout.getReader().read()
          if (first.done) {
            await child.exited
            return undefined
          }
          return JSON.parse(new TextDecoder().decode(first.value)) as { pid: number }
        }),
      )
      const winners = results.filter((result) => result !== undefined)
      expect(winners).toHaveLength(1)
      expect((await Bun.file(join(file + ".owner", "owner.json")).json()).pid).toBe(winners[0]?.pid)
      const winner = contenders.find((child) => child.pid === winners[0]?.pid)!
      winner.stdin!.write("stop\n")
      await winner.exited
      await Effect.runPromise(
        Effect.scoped(DatabaseProcessOwner.acquire(file)).pipe(Effect.provideService(Global.Service, Global.make())),
      )
    } finally {
      previous.kill("SIGKILL")
      await previous.exited
      for (const child of contenders) child.kill("SIGKILL")
      await Promise.all(contenders.map((child) => child.exited))
      await rm(root, { recursive: true, force: true })
    }
  },
  10_000,
)

test.skipIf(process.platform !== "linux")(
  "database ownership survives rejected contenders and lasts until its scope closes",
  async () => {
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
  },
)

test.skipIf(process.platform !== "linux" || !Bun.which("unshare"))(
  "foreign PID/network ownership stays blocked even after SIGKILL",
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
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
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
      await expect(acquire()).rejects.toThrow("another execution domain")
      child.kill("SIGKILL")
      await child.exited
      await expect(acquire()).rejects.toThrow("another execution domain")
      // The fixture has verified its own child exited; production never clears foreign ownership.
      await rm(file + ".owner", { recursive: true })
      await acquire()
    } finally {
      child.kill("SIGKILL")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  },
  10_000,
)

test.skipIf(process.platform !== "linux" || !Bun.which("node"))(
  "Node and Bun runtimes contend for the same database lease",
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
      child.kill("SIGKILL")
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

test.skipIf(process.platform !== "linux")(
  "directory symlinks and relative paths cannot bypass database ownership",
  async () => {
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
  },
)

test.skipIf(process.platform !== "linux")(
  "ownership is retained while later shutdown finalizers are still draining",
  async () => {
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
  },
)
