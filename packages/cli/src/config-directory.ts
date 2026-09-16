import { Global } from "@opencode/util/global"

export function configDirectory() {
  const configured = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (configured) return configured
  return Global.Path.config
}
