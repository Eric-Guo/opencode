import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

test("worker RPC releases unreachable signals and receivers without invalidating shared methods", async () => {
  await using directory = await tmpdir()
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixture/rpc-lifetime.ts")],
    outdir: directory.path,
    target: "node",
  })
  expect(result.success).toBe(true)
  const child = Bun.spawn(["node", "--expose-gc", join(directory.path, "rpc-lifetime.js")], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  })
  const timeout = setTimeout(() => child.kill(), 5000)
  try {
    const output = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(output[1]).toBe("")
    expect(output[2]).toBe(0)
    expect(output[0]).toContain("RPC lifetimes released")
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
  }
}, 10000)
