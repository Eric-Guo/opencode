import { expect, test } from "bun:test"
import { getCurrentSidecarTarget, resolveChannel } from "./utils"

test("normalizes unsupported desktop channels to dev", () => {
  expect(resolveChannel("eric_dev")).toBe("dev")
  expect(resolveChannel("dev")).toBe("dev")
  expect(resolveChannel("beta")).toBe("beta")
  expect(resolveChannel("prod")).toBe("prod")
})

test("maps Rust targets to embedded sidecar targets", () => {
  expect(getCurrentSidecarTarget("x86_64-pc-windows-msvc")).toBe("windows-x64")
  expect(getCurrentSidecarTarget("aarch64-apple-darwin")).toBe("darwin-arm64")
  expect(getCurrentSidecarTarget("x86_64-unknown-linux-gnu")).toBe("linux-x64")
})
