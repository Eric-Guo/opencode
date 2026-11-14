import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonObject } from "@cybros/agent"

const rules: readonly [RegExp, string][] = [
  [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b[^|;&]*\s(\/|~|\$HOME|\/\*)(\s|$)/,
    "recursive delete of a root directory",
  ],
  [/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, "force push rewrites shared history"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "piping a download into a shell"],
  [/(^|[;&|]\s*)sudo\b/, "elevation is unavailable to unattended work"],
  [/\bmkfs(\.\w+)?\b/, "formatting a filesystem"],
  [/\bdd\b[^|;&]*\bof=\/dev\//, "writing raw bytes to a device"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "powering the machine off"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "a fork bomb"],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, "opening the root filesystem to everyone"],
]

/** A shared literal refusal floor, matching Rho; it does not confine arbitrary shell programs. */
export function runnerRefusal(name: string, input: JsonObject, cwd: string, protectedRoots: readonly string[] = []) {
  const roots = [fileURLToPath(new URL("../", import.meta.url)), ...protectedRoots]
  if (["bash", "start_process"].includes(name) && typeof input.command === "string") {
    const command = input.command
    const found = rules.find(([pattern]) => pattern.test(command))
    if (found) return "Refused: " + found[1] + "."
    if (roots.some((root) => command.includes(root))) return "Refused: the command names protected runtime state."
  }
  if (["write", "edit"].includes(name) && typeof input.path === "string") {
    const path = resolve(
      cwd,
      input.path === "~"
        ? homedir()
        : input.path.startsWith("~/")
          ? resolve(homedir(), input.path.slice(2))
          : input.path,
    )
    if (
      roots.some((root) => {
        const from = relative(root, path)
        return !isAbsolute(from) && from !== ".." && !from.startsWith(".." + sep)
      })
    )
      return "Refused: the path is inside protected runtime state."
  }
}
