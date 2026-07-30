import { expect, test } from "bun:test"

import { getCurrentSidecarTarget } from "./utils"

test("maps Rust targets to embedded sidecar targets", () => {
  expect(getCurrentSidecarTarget("x86_64-pc-windows-msvc")).toBe("windows-x64")
  expect(getCurrentSidecarTarget("aarch64-apple-darwin")).toBe("darwin-arm64")
  expect(getCurrentSidecarTarget("x86_64-unknown-linux-gnu")).toBe("linux-x64")
})
