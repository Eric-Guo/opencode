import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

test.each([false, true])("resolves the writable global configuration directory (custom: %p)", async (custom) => {
  await using tmp = await tmpdir("opencode-config-directory-")
  const configured = custom ? path.join(tmp.path, "custom-config") : undefined
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'import { configDirectory } from "./src/config-directory.ts"; console.log(JSON.stringify({ config: configDirectory() }))',
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(tmp.path, { OPENCODE_CONFIG_DIR: configured }),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(stdout)).toEqual({
    config: configured ?? path.join(tmp.path, "xdg-config", "opencode"),
  })
})
