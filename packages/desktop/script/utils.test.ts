import { expect, test } from "bun:test"

import { getCliResourcePath, getCurrentCli, resolveChannel } from "./utils"

test("normalizes unsupported desktop channels to dev", () => {
  expect(resolveChannel("eric_dev")).toBe("dev")
  expect(resolveChannel("dev")).toBe("dev")
  expect(resolveChannel("beta")).toBe("beta")
  expect(resolveChannel("prod")).toBe("prod")
})

test("uses the target platform for the CLI resource extension", () => {
  expect(getCliResourcePath(getCurrentCli("x86_64-pc-windows-msvc"))).toBe("resources/opencode-cli.exe")
  expect(getCliResourcePath(getCurrentCli("aarch64-apple-darwin"))).toBe("resources/opencode-cli")
  expect(getCliResourcePath(getCurrentCli("x86_64-unknown-linux-gnu"))).toBe("resources/opencode-cli")
})

test("maps desktop build targets to Node CLI packages", () => {
  expect(getCurrentCli("x86_64-pc-windows-msvc").target).toBe("windows-x64")
  expect(getCurrentCli("aarch64-pc-windows-msvc").target).toBe("windows-arm64")
  expect(getCurrentCli("aarch64-apple-darwin").target).toBe("darwin-arm64")
  expect(getCurrentCli("x86_64-unknown-linux-gnu").target).toBe("linux-x64")
})

test.each([
  { target: "aarch64-apple-darwin", package: "@lydell/node-pty-darwin-arm64" },
  { target: "x86_64-pc-windows-msvc", package: "@lydell/node-pty-win32-x64" },
  { target: "x86_64-unknown-linux-gnu", package: "@lydell/node-pty-linux-x64" },
])("build configuration helpers load in Node for $target", async (input) => {
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `import { RUST_TARGET, nodePtyPackage } from ${JSON.stringify(new URL("./utils.ts", import.meta.url).href)}
console.log(JSON.stringify({ target: RUST_TARGET, package: nodePtyPackage() }))`,
    ],
    {
      env: { ...process.env, RUST_TARGET: input.target, OPENCODE_CLI_TARGET: input.target },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual(input)
})
