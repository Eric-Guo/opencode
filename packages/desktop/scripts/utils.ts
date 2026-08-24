import { $ } from "bun"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(raw = Bun.env.OPENCODE_CHANNEL): Channel {
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

const SIDECAR_TARGETS = [
  { rustTarget: "aarch64-apple-darwin", target: "darwin-arm64" },
  { rustTarget: "x86_64-apple-darwin", target: "darwin-x64" },
  { rustTarget: "aarch64-pc-windows-msvc", target: "windows-arm64" },
  { rustTarget: "x86_64-pc-windows-msvc", target: "windows-x64" },
  { rustTarget: "x86_64-unknown-linux-gnu", target: "linux-x64" },
  { rustTarget: "aarch64-unknown-linux-gnu", target: "linux-arm64" },
] as const

function nativeTarget() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (process.platform === "win32")
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (process.platform === "linux")
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`)
}

export function getCurrentSidecarTarget(target = Bun.env.RUST_TARGET ?? nativeTarget()) {
  const sidecar = SIDECAR_TARGETS.find((item) => item.rustTarget === target)
  if (!sidecar) throw new Error(`Sidecar configuration not available for target '${target}'`)
  return sidecar.target
}

export async function buildEmbeddedSidecar() {
  await $`bun ../cli/script/build-node.ts --sidecar-only --skip-install ${`--target=${getCurrentSidecarTarget()}`}`
}
