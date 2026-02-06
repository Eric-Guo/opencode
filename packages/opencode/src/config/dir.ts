import path from "path"
import { Flag } from "../flag/flag"

export function resolveConfigDir() {
  const raw = Flag.OPENCODE_CONFIG_DIR
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return path.join(path.dirname(process.execPath), "thape-config")
}
