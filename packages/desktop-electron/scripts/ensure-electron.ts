#!/usr/bin/env bun
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const electronModulePath = path.dirname(require.resolve("electron"))
const pathFile = path.join(electronModulePath, "path.txt")
const executablePath = await Bun.file(pathFile).exists() ? (await Bun.file(pathFile).text()).trim() : ""

if (!executablePath || !await Bun.file(path.join(electronModulePath, "dist", executablePath)).exists()) {
  const install = Bun.spawn(["node", path.join(electronModulePath, "install.js")], {
    cwd: electronModulePath,
    env:
      process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
        ? { ...process.env, ELECTRON_GET_USE_PROXY: "1" }
        : process.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const code = await install.exited
  if (code !== 0) process.exit(code)
}
