import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { writeFile } from "node:fs/promises"
import { Service } from "../src/effect/service"
import { Service as PromiseService } from "../src/promise/service"
import { serviceFixture } from "./fixture/service-fixture"
import { accelerate } from "./fixture/service-timing"

const variants = [
  { name: "effect", ensure: (options: Parameters<typeof Service.ensure>[0]) => run(accelerate(Service.ensure)(options)), stop: (options: Parameters<typeof Service.stop>[0]) => run(Service.stop(options)) },
  { name: "promise", ensure: accelerate(PromiseService.ensure), stop: PromiseService.stop },
]

for (const variant of variants) {
  test.skipIf(process.platform !== "linux")(`${variant.name}: foreign namespace registration cannot start a contender`, async () => {
    await using fixture = await serviceFixture()
    const info = { url: "http://127.0.0.1:1", pid: 1, provenance: { platform: "linux", boot: "foreign", pidNamespace: "pid:[1]", netNamespace: "net:[1]", started: "1" } }
    await writeFile(fixture.registration, JSON.stringify(info))

    await expect(variant.ensure({ file: fixture.registration, command: fixture.command("record-start") })).rejects.toThrow(/different.*namespace|different.*domain/i)
    expect(await Bun.file(fixture.registration + ".started").exists()).toBe(false)
    expect(await Bun.file(fixture.registration).json()).toEqual(info)
  })

  test.skipIf(process.platform !== "linux")(`${variant.name}: foreign namespace registration cannot signal a coincident local PID`, async () => {
    await using fixture = await serviceFixture()
    const child = fixture.spawn("compatible")
    await fixture.waitForFile()
    const info = { ...(await Bun.file(fixture.registration).json()), provenance: { platform: "linux", boot: "foreign", pidNamespace: "pid:[1]", netNamespace: "net:[1]", started: "1" } }
    await writeFile(fixture.registration, JSON.stringify(info))

    await expect(variant.stop({ file: fixture.registration })).rejects.toThrow(/different.*namespace|different.*domain/i)
    expect(child.exitCode).toBe(null)
    expect(await Bun.file(fixture.registration).json()).toEqual(info)
  })
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
}
