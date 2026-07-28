import { describe, expect, test } from "bun:test"
import { selectCommandSet } from "../../src/cli/command-selection"

describe("CLI command selection", () => {
  test("loads only the TUI command for the default invocation", () => {
    expect(selectCommandSet([])).toBe("tui")
    expect(selectCommandSet(["/tmp/project", "--session", "ses_test"])).toBe("tui")
  })

  test("loads only the hidden server command wherever global flags appear", () => {
    expect(selectCommandSet(["--print-logs", "__v2-serve", "--stdio"])).toBe("server")
  })

  test("loads all public commands for named commands, aliases, and help", () => {
    expect(selectCommandSet(["serve"])).toBe("all")
    expect(selectCommandSet(["auth", "login"])).toBe("all")
    expect(selectCommandSet(["plug", "example"])).toBe("all")
    expect(selectCommandSet(["--help"])).toBe("all")
  })
})
