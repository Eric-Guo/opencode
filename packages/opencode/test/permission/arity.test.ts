import { test, expect } from "bun:test"
import { ShellArity } from "../../src/tool/shell/arity"

test("arity 1 - unknown commands default to first token", () => {
  expect(ShellArity.prefix(["unknown", "command", "subcommand"], "bash")).toEqual(["unknown"])
  expect(ShellArity.prefix(["touch", "foo.txt"], "bash")).toEqual(["touch"])
})

test("arity 2 - two token commands", () => {
  expect(ShellArity.prefix(["git", "checkout", "main"], "bash")).toEqual(["git", "checkout"])
  expect(ShellArity.prefix(["docker", "run", "nginx"], "bash")).toEqual(["docker", "run"])
})

test("arity 3 - three token commands", () => {
  expect(ShellArity.prefix(["aws", "s3", "ls", "my-bucket"], "bash")).toEqual(["aws", "s3", "ls"])
  expect(ShellArity.prefix(["npm", "run", "dev", "script"], "bash")).toEqual(["npm", "run", "dev"])
})

test("longest match wins - nested prefixes", () => {
  expect(ShellArity.prefix(["docker", "compose", "up", "service"], "bash")).toEqual(["docker", "compose", "up"])
  expect(ShellArity.prefix(["consul", "kv", "get", "config"], "bash")).toEqual(["consul", "kv", "get"])
})

test("exact length matches", () => {
  expect(ShellArity.prefix(["git", "checkout"], "bash")).toEqual(["git", "checkout"])
  expect(ShellArity.prefix(["npm", "run", "dev"], "bash")).toEqual(["npm", "run", "dev"])
})

test("edge cases", () => {
  expect(ShellArity.prefix([], "bash")).toEqual([])
  expect(ShellArity.prefix(["single"], "bash")).toEqual(["single"])
  expect(ShellArity.prefix(["git"], "bash")).toEqual(["git"])
})

test("powershell verb-noun structures", () => {
  expect(ShellArity.prefix(["Get-Content", "file.txt"], "pwsh")).toEqual(["Get-Content"])
  expect(ShellArity.prefix(["Remove-Item", "-Recurse", "dir"], "powershell")).toEqual(["Remove-Item"])
  expect(ShellArity.prefix(["git", "checkout", "main"], "pwsh")).toEqual(["git", "checkout"])
  expect(ShellArity.prefix(["redis-cli", "ping"], "pwsh")).toEqual(["redis-cli", "ping"])
})
