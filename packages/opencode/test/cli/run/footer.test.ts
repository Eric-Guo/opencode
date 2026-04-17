import { expect, test } from "bun:test"
import { RunFooter } from "../../../src/cli/cmd/run/footer"

test("run footer class loads", () => {
  expect(typeof RunFooter).toBe("function")
})
