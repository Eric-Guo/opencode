import { expect, test } from "bun:test"
import { RunFooterView } from "../../../src/cli/cmd/run/footer.view"

test("run footer view loads", () => {
  expect(typeof RunFooterView).toBe("function")
})
