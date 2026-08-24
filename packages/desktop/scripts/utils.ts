export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(raw = process.env.OPENCODE_CHANNEL): Channel {
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
}

export const SIDECAR_TARGETS = [
  { rustTarget: "aarch64-apple-darwin", target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { rustTarget: "x86_64-apple-darwin", target: "darwin-x64", os: "darwin", cpu: "x64" },
  { rustTarget: "aarch64-pc-windows-msvc", target: "windows-arm64", os: "win32", cpu: "arm64" },
  { rustTarget: "x86_64-pc-windows-msvc", target: "windows-x64", os: "win32", cpu: "x64" },
  { rustTarget: "x86_64-unknown-linux-gnu", target: "linux-x64", os: "linux", cpu: "x64" },
  { rustTarget: "aarch64-unknown-linux-gnu", target: "linux-arm64", os: "linux", cpu: "arm64" },
] as const

function nativeTarget() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (process.platform === "win32")
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (process.platform === "linux")
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`)
}

export function getCurrentSidecar(
  target = process.env.OPENCODE_CLI_TARGET ?? process.env.RUST_TARGET ?? nativeTarget(),
) {
  const sidecar = SIDECAR_TARGETS.find((item) => item.rustTarget === target || item.target === target)
  if (!sidecar) throw new Error(`Sidecar configuration not available for target '${target}'`)
  return sidecar
}

export function getCurrentSidecarTarget(target?: string) {
  return getCurrentSidecar(target).target
}

export function nodePtyPackage(target?: string) {
  const sidecar = getCurrentSidecar(target)

  return `@lydell/node-pty-${sidecar.os}-${sidecar.cpu}`
}

export async function buildEmbeddedSidecar() {
  const { $ } = await import("bun")

  await $`bun ../cli/script/build-node.ts --sidecar-only --skip-install ${`--target=${getCurrentSidecarTarget()}`}`
}
