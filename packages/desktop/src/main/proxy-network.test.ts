import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("Node transports send HTTP and HTTPS through the configured proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-proxy-"))
  const fixtures = join(import.meta.dir, "../../test/fixture")

  try {
    await symlink(join(import.meta.dir, "../../node_modules"), join(directory, "node_modules"), "junction")

    const build = await Bun.build({
      entrypoints: [join(fixtures, "proxy-node.ts")],
      target: "node",
      format: "esm",
      external: ["ws"],
    })

    expect(build.success).toBe(true)
    await Bun.write(join(directory, "proxy.mjs"), build.outputs[0]!)

    const child = Bun.spawn(
      [
        process.env.OPENCODE_DESKTOP_NODE ?? "node",
        join(directory, "proxy.mjs"),
        join(fixtures, "proxy-key.pem"),
        join(fixtures, "proxy-cert.pem"),
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(fixtures, "proxy-cert.pem") },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      },
    )

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("WebSockets, loopback and Direct passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
