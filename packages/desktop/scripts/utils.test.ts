import { expect, test } from "bun:test"

import { getCliResourcePath, getCurrentCli } from "./utils"

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
