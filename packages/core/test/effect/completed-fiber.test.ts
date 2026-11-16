import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { it } from "../lib/effect"

it.live(
  "completed cached fibers release old services and preserve failure diagnostics",
  Effect.promise(async () => {
    // V8's lazy Error stacks caused this retention; exercise Node with explicit GC.
    const child = Bun.spawn(["node", "--expose-gc", path.join(import.meta.dir, "../fixture/completed-fiber.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout.trim()).toBe("completed-fiber regression passed")
  }),
)
