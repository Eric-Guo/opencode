import { execFile } from "node:child_process"
import { lstat } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

export async function findFiles(path: string, glob: string, limit: number, signal: AbortSignal) {
  let parent = path
  let repository = false
  while (true) {
    if (
      await lstat(join(parent, ".git")).then(
        () => true,
        () => false,
      )
    ) {
      repository = true
      break
    }
    if (dirname(parent) === parent) break
    parent = dirname(parent)
  }
  const pattern = glob.includes("/") && !glob.startsWith("/") && !glob.startsWith("**/") ? "**/" + glob : glob
  const parameters = [
    "--glob",
    "--color=never",
    "--hidden",
    "--print0",
    ...(repository ? [] : ["--no-require-git"]),
    "--max-results",
    String(limit),
    ...(glob.includes("/") ? ["--full-path"] : []),
    "--",
    pattern,
    path,
  ]
  const run = (name: string) =>
    execute(name, parameters, { signal, encoding: "utf8", maxBuffer: 51200, windowsHide: true })
  const found = await run("fd")
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return run("fdfind")
      throw error
    })
    .then(
      (value) => ({ text: value.stdout, truncated: false }),
      (error: unknown) => {
        signal.throwIfAborted()
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
          "stdout" in error &&
          typeof error.stdout === "string"
        )
          return { text: error.stdout.slice(0, error.stdout.lastIndexOf("\0") + 1), truncated: true }
        return {
          error:
            error instanceof Error && "code" in error && error.code === "ENOENT"
              ? "fd not found on PATH (looked for fd, fdfind). Install fd to use find."
              : error instanceof Error
                ? error.message
                : String(error),
        }
      },
    )
  if ("error" in found) return { is_error: true, content: found.error }
  const paths = found.text
    .split("\0")
    .filter(Boolean)
    .map((file) => relative(path, file) + (file.endsWith("/") ? "/" : ""))
  return {
    content: paths.length
      ? paths.join("\n") +
        (paths.length >= limit ? `\n\n[${limit} results limit reached. Refine the pattern for more.]` : "") +
        (found.truncated ? "\n\n[50 KiB limit reached.]" : "")
      : "No files found matching pattern under " + path,
    structured_content: { limit_reached: paths.length >= limit, truncated: found.truncated },
  }
}
