import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"

import { cliInstallPath } from "../cli-install"
import { cleanStages } from "./cli-stages"

describe("cleanStages", () => {
  test.each([
    { name: "upgrade", staged: ["2.0.18", "2.0.19", "2.0.20"], current: "2.0.20" },
    { name: "downgrade", staged: ["2.0.18", "2.0.19", "2.0.20"], current: "2.0.18" },
    { name: "prerelease", staged: ["2.0.20", "2.1.0-beta.1", "local"], current: "2.1.0-beta.1" },
    { name: "adopted server", staged: ["2.0.18", "2.0.19", "2.0.20"], current: "2.0.20", keep: ["2.0.19"] },
  ])("keeps only the current and adopted staged CLIs after $name", async (input) => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stages-"))

    try {
      input.staged.forEach((version) => {
        mkdirSync(path.join(root, version))
        writeFileSync(path.join(root, version, "opencode-cli"), version)
      })
      writeFileSync(path.join(root, "unrelated"), "")
      mkdirSync(path.join(root, "unrelated-directory"))
      writeFileSync(path.join(root, "unrelated-directory", "state"), "")

      await Effect.runPromise(
        cleanStages(path.join(root, input.current, "opencode-cli"), { root, keep: input.keep }).pipe(
          Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        ),
      )

      expect(readdirSync(root).sort()).toEqual(
        [input.current, ...(input.keep ?? []), "unrelated", "unrelated-directory"].sort(),
      )
      expect(readdirSync(path.join(root, input.current))).toEqual(["opencode-cli"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("cleans packaged CLI files without touching the desktop profile", async () => {
    const userData = mkdtempSync(path.join(tmpdir(), "opencode-cli-stages-"))
    const current = cliInstallPath(userData, "2.4.0-x64")
    const old = cliInstallPath(userData, "2.3.2-x64")
    const root = path.dirname(current)

    try {
      mkdirSync(root)
      writeFileSync(current, "current CLI")
      writeFileSync(old, "old CLI")
      writeFileSync(`${old}.123.tmp`, "staged copy in progress")
      writeFileSync(path.join(root, "unrelated"), "")

      for (const [directory, file] of [
        ["logs", "main.log"],
        ["Local Storage", "state"],
      ]) {
        mkdirSync(path.join(userData, directory))
        writeFileSync(path.join(userData, directory, file), "desktop data")
      }

      await Effect.runPromise(
        cleanStages(current, { root }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
      )

      expect(readdirSync(userData).sort()).toEqual(["Local Storage", "cli", "logs"])
      expect(readdirSync(path.join(userData, "logs"))).toEqual(["main.log"])
      expect(readdirSync(path.join(userData, "Local Storage"))).toEqual(["state"])
      expect(readdirSync(root).sort()).toEqual(
        [path.basename(current), path.basename(`${old}.123.tmp`), "unrelated"].sort(),
      )
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
