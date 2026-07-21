declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "0.0.0-eric_dev-202607200407"
export const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const local = channel === "local"

export const InstallationVersion = version
export const InstallationChannel = channel
export const InstallationLocal = local
