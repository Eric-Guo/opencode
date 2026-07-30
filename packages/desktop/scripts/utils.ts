import { $ } from "bun"
import { chmod, copyFile, rm } from "node:fs/promises"
import { join } from "node:path"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const CLI_BINARIES: Array<{ rustTarget: string; target: string; os: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    target: "darwin-arm64",
    os: "darwin",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    target: "darwin-x64-baseline",
    os: "darwin",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    target: "windows-arm64",
    os: "win32",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    target: "windows-x64-baseline",
    os: "win32",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    target: "linux-x64-baseline",
    os: "linux",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    target: "linux-arm64",
    os: "linux",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export function getCliResourcePath(cli = getCurrentCli()) {
  return cli.os === "win32" ? "resources/opencode-cli.exe" : "resources/opencode-cli"
}

export async function buildCliToResources() {
  const cli = getCurrentCli()
  const dest = getCliResourcePath(cli)
  await rm(cli.os === "win32" ? "resources/opencode-cli" : "resources/opencode-cli.exe", { force: true })
  await $`bun ../cli/script/build.ts --skip-install ${`--target=${cli.target}`}`
  await copyFile(
    join("../cli/dist", `cli-${cli.target}`, "bin", cli.os === "win32" ? "opencode2.exe" : "opencode2"),
    dest,
  )
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Built ${cli.target} CLI at ${dest}`)
}
