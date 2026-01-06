#!/usr/bin/env bun
import fs from "fs/promises"
import path from "path"

const SOURCE_DIR = path.resolve("src-tauri/resources")
const DEST_DIR = path.resolve("src-tauri/resources-dist")
const SKIP_NAMES = new Set([".git",".gitignore","opencode-thape.sublime-project","opencode-thape.sublime-workspace","AGENTS.md"])

async function runBunInstall(cwd: string) {
  const proc = Bun.spawn(["bun", "install"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`bun install failed in ${cwd} with exit code ${exitCode}`)
  }
}

async function copyDir(source: string, dest: string) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })

  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue

    const sourcePath = path.join(source, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(sourcePath, destPath)
      continue
    }

    if (entry.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath)
      await fs.symlink(target, destPath)
      continue
    }

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, destPath)
    }
  }
}

async function main() {
  await fs.access(SOURCE_DIR)
  await fs.rm(DEST_DIR, { recursive: true, force: true })
  await copyDir(SOURCE_DIR, DEST_DIR)
  await runBunInstall(DEST_DIR)
}

await main()
