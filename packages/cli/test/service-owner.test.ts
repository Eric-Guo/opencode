import { NodeFileSystem } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { expect, test } from "bun:test"
import { Effect, Exit, FileSystem, Scope } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServiceRegistration } from "../src/services/service-registration"

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
}

test("registration lease excludes competing publishers even with independent database leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-registration-owner-"))
  const file = join(root, "service.json")
  const scope = await Effect.runPromise(Scope.make())
  const options = {
    address: { _tag: "TcpAddress" as const, hostname: "127.0.0.1", port: 12345 },
    file,
    password: "fixture",
    shutdown: Effect.never,
  }
  try {
    const cleanup = await run(
      ServiceRegistration.register({ ...options, id: "first" }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const original = await Bun.file(file).text()
    await expect(run(Effect.scoped(ServiceRegistration.register({ ...options, id: "second" })))).rejects.toThrow(
      "Another managed service owns this registration",
    )
    expect(await Bun.file(file).text()).toBe(original)
    await run(cleanup)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const nextCleanup = yield* ServiceRegistration.register({ ...options, id: "second" })
          yield* nextCleanup
        }),
      ),
    )
    expect(await Bun.file(file).exists()).toBe(false)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "linux")(
  "registration publisher refuses a foreign owner without overwriting its record",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-registration-foreign-"))
    const file = join(root, "service.json")
    const info = {
      id: "foreign",
      url: "http://127.0.0.1:1",
      pid: process.pid,
      provenance: { ...(await Effect.runPromise(Service.provenance)), netNamespace: "net:[foreign]" },
    }
    await writeFile(file, JSON.stringify(info))
    try {
      await expect(
        run(
          Effect.scoped(
            ServiceRegistration.register({
              address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 12345 },
              file,
              password: "fixture",
              id: "new",
              shutdown: Effect.never,
            }),
          ),
        ),
      ).rejects.toThrow("different execution domain or namespace")
      expect(await Bun.file(file).json()).toEqual(info)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
