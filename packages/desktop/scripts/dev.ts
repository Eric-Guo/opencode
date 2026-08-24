import { $ } from "bun"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { prepareDevElectron } from "./dev-electron"
import { buildEmbeddedSidecar } from "./utils"

async function main() {
  process.env.OPENCODE_CHANNEL = "local"
  process.env.OPENCODE_VERSION = `2.0.0-local-${Date.now()}`
  process.env.OPENCODE_DISABLE_CHANNEL_DB = "0"
  if (process.platform === "win32") {
    process.env.OPENCODE_DESKTOP_WSL_CLI_BUILD = join(import.meta.dirname, "../../cli/script/build.ts")
    process.env.OPENCODE_DESKTOP_WSL_CLI_OUTPUT = join(import.meta.dirname, "../resources/opencode-cli-wsl")
  }
  await Promise.all([
    $`bun run install-electron`,
    $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL}`,
    buildEmbeddedSidecar(),
  ])
  if (process.platform === "darwin") process.env.ELECTRON_EXEC_PATH = await prepareDevElectron()
  await startDesktop(process.argv.slice(2))
}

async function startDesktop(args: string[]) {
  // Bun's implicit spawn environment omits values set during preparation.
  process.exitCode = await Bun.spawn(
    ["node", fileURLToPath(new URL("../bin/electron-vite.js", import.meta.resolve("electron-vite"))), "dev", ...args],
    { env: process.env, stdio: ["inherit", "inherit", "inherit"] },
  ).exited
}

await main()
