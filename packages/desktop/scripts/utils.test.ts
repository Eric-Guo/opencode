import { expect, test } from "bun:test"

import { getCliResourcePath, getCurrentCli } from "./utils"

test("uses the target platform for the CLI resource extension", () => {
  expect(getCliResourcePath(getCurrentCli("x86_64-pc-windows-msvc"))).toBe("resources/opencode-cli.exe")
  expect(getCliResourcePath(getCurrentCli("aarch64-apple-darwin"))).toBe("resources/opencode-cli")
  expect(getCliResourcePath(getCurrentCli("x86_64-unknown-linux-gnu"))).toBe("resources/opencode-cli")
})
