import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Service } from "../src/effect/service"
import { discover, stop } from "../src/promise/service"
import { serviceFixture } from "./fixture/service-fixture"

const variants = [
  {
    name: "effect",
    discover: (file: string) => run(Service.discover({ file })),
    stop: (file: string) => run(Service.stop({ file, pty: "handoff" })),
  },
  {
    name: "promise",
    discover: (file: string) => discover({ file }),
    stop: (file: string) => stop({ file, pty: "handoff" }),
  },
]

for (const variant of variants) {
  test.skipIf(process.platform !== "linux")(
    `${variant.name}: legacy owner is never probed, signalled, or rewritten`,
    async () => {
      await using fixture = await serviceFixture()
      const child = fixture.spawn("hanging")
      await fixture.waitForFile()
      const { provenance: _provenance, ...info } = await Bun.file(fixture.registration).json()
      await writeFile(fixture.registration, JSON.stringify(info))
      await expect(variant.discover(fixture.registration)).rejects.toThrow("Legacy service registration")
      await expect(variant.stop(fixture.registration)).rejects.toThrow("Legacy service registration")
      expect(child.exitCode).toBe(null)
      expect(await Bun.file(fixture.registration + ".requests").exists()).toBe(false)
      expect(await Bun.file(fixture.registration).json()).toEqual(info)
    },
  )

  test.skipIf(process.platform !== "linux")(`${variant.name}: reused PID is not probed or signalled`, async () => {
    await using fixture = await serviceFixture()
    const child = fixture.spawn("hanging")
    await fixture.waitForFile()
    const info = await Bun.file(fixture.registration).json()
    info.provenance.started = "0"
    await writeFile(fixture.registration, JSON.stringify(info))
    expect(await variant.discover(fixture.registration)).toBeUndefined()
    await variant.stop(fixture.registration)
    expect(child.exitCode).toBe(null)
    expect(await Bun.file(fixture.registration + ".requests").exists()).toBe(false)
    expect(await Bun.file(fixture.registration).json()).toEqual(info)
  })

  test.skipIf(process.platform !== "linux")(
    `${variant.name}: malformed process identity is not treated as a dead owner`,
    async () => {
      await using fixture = await serviceFixture()
      fixture.spawn("hanging")
      await fixture.waitForFile()
      const info = await Bun.file(fixture.registration).json()
      info.provenance.started = "invalid"
      await writeFile(fixture.registration, JSON.stringify(info))
      await expect(variant.stop(fixture.registration)).rejects.toThrow("Invalid service process identity")
      expect(await Bun.file(fixture.registration).json()).toEqual(info)
    },
  )
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
}

test.skipIf(process.platform !== "linux" || !Bun.which("unshare"))(
  "inherited ancestor procfs is not trusted as the caller's PID namespace",
  async () => {
    const child = Bun.spawn(
      ["unshare", "-Urnpf", "--kill-child", process.execPath, join(import.meta.dir, "fixture/service-provenance.ts")],
      { stdout: "pipe", stderr: "pipe" },
    )
    try {
      expect(await child.exited).toBe(1)
      expect(await new Response(child.stderr).text()).toContain("/proc uses a different PID namespace")
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  },
)
