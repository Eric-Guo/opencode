import path from "node:path"

export function configDirectory() {
  const configured = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (configured) return configured
  return path.join(path.dirname(process.execPath), "thape-config")
}
