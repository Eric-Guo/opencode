import { resolveConfigDir } from "./dir"

export function resolveEnv(key: string) {
  if (key === "OPENCODE_CONFIG_DIR") return resolveConfigDir()
  return process.env[key] || ""
}

export function substituteEnv(content: string) {
  return content.replace(/\{env:([^}]+)\}/g, (_, key) => resolveEnv(key))
}
