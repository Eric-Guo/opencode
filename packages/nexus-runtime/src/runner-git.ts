import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { JsonObject } from "@cybros/agent"
import { missing } from "./storage"

const execute = promisify(execFile)
export async function runGit(root: string, args: string[], signal?: AbortSignal) {
  return execute("git", args, { cwd: root, signal, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true })
}

export async function gitReview(
  directory: string,
  input: JsonObject,
  signal: AbortSignal,
): Promise<{ content: string; structured_content?: JsonObject; is_error?: boolean }> {
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(10000)
  const root = resolve(directory, typeof input.root === "string" ? input.root : ".")
  try {
    return await readGitReview(root, input, AbortSignal.any([signal, timeout]))
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) return { is_error: true, content: "review_timeout: the Git read exceeded 10 seconds" }
    if (missing(error))
      return { is_error: true, content: "git_unavailable: Git or the working directory is unavailable" }
    throw error
  }
}

async function readGitReview(root: string, input: JsonObject, active: AbortSignal) {
  const git = async (cwd: string, args: string[]) =>
    execute("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      signal: active,
      encoding: "buffer",
      maxBuffer: 32768,
      windowsHide: true,
    }).then(
      (result) => ({ text: result.stdout.toString(), bytes: result.stdout, status: 0, truncated: false }),
      (error: unknown) => {
        active.throwIfAborted()
        if (missing(error)) throw error
        if (!(error instanceof Error) || !("stdout" in error) || !Buffer.isBuffer(error.stdout)) throw error
        return {
          text: error.stdout.subarray(0, 32768).toString(),
          bytes: error.stdout.subarray(0, 32768),
          status: "code" in error ? error.code : -1,
          truncated: "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }
      },
    )
  const top = await git(root, ["rev-parse", "--show-toplevel"])
  if (top.status !== 0) return { is_error: true, content: "not_git: select a Git working directory" }
  const worktree = top.text.replace(/\n$/, "")
  const base =
    typeof input.base === "string" ? input.base : (await git(worktree, ["rev-parse", "--verify", "HEAD"])).text.trim()
  if (!/^[a-f0-9]{40,64}$/.test(base))
    return { is_error: true, content: "base_unavailable: a committed HEAD is required" }
  const names = await git(worktree, ["diff", "--no-renames", "--name-status", "-z", base, "--"])
  if (names.status !== 0 && !names.truncated)
    return { is_error: true, content: "base_unavailable: the comparison commit is unavailable" }
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (untracked.status !== 0 && !untracked.truncated)
    return { is_error: true, content: "git_failed: unable to list untracked files" }
  const complete = (result: typeof names) =>
    result.truncated ? result.text.slice(0, result.text.lastIndexOf("\0") + 1) : result.text
  const changed = complete(names).split("\0")
  const files: { status: string; path: string; untracked?: true }[] = [
    ...Array.from({ length: Math.floor(changed.length / 2) }, (_, index) => ({
      status: changed[index * 2],
      path: changed[index * 2 + 1],
    })),
    ...complete(untracked)
      .split("\0")
      .filter(Boolean)
      .map((path) => ({ status: "A", path, untracked: true as const })),
  ]
  const document: JsonObject = {
    root: worktree,
    base,
    files: files.slice(0, 200),
    truncated: names.truncated || untracked.truncated || files.length > 200,
  }
  if (input.path !== undefined) {
    const file = files.find((file) => file.path === input.path)
    if (!file) return { is_error: true, content: "file_changed: refresh the changed files" }
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3"]
    const result = await git(
      worktree,
      file.untracked
        ? [
            ...args,
            "--no-index",
            "--",
            process.platform === "win32" ? "NUL" : "/dev/null",
            resolve(worktree, file.path),
          ]
        : [...args, base, "--", file.path],
    )
    const state = result.truncated
      ? "too_large"
      : result.status !== 0 && result.status !== 1
        ? "unavailable"
        : !Buffer.from(result.text).equals(result.bytes) || /^(Binary files |GIT binary patch)/m.test(result.text)
          ? "binary"
          : "text"
    document.file = {
      ...file,
      state,
      patch: state === "text" ? result.text : null,
      fingerprint: createHash("sha256").update(result.bytes).digest("hex"),
    }
  }
  return { content: "Git working directory compared with " + base, structured_content: document }
}
