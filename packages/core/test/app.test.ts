import { expect, test } from "bun:test"
import { App } from "@opencode/core/app"
import pkg from "../package.json"

test("formats app metadata as a user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe("opencode/beta/1.2.3/sdk")
})

test.each(["0.0.0-dev-202609170121", "0.0.0-beta-17403.2", "0.0.0", "local", "unknown"])(
  "uses the package version for development user agents: %s",
  (version) => {
    const app = App.make({ name: "cli", version, channel: "dev" })
    expect(App.useragent(app)).toBe(`opencode/dev/${pkg.version}/cli`)
    expect(app.version).toBe(version)
  },
)

test.each(["2.0.4", "2.1.0-beta.1"])("preserves release versions in user agents: %s", (version) => {
  expect(App.useragent(App.make({ name: "cli", version, channel: "beta" }))).toBe(`opencode/beta/${version}/cli`)
})
