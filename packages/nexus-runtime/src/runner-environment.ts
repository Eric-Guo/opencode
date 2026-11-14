import { resolve } from "node:path"
import { runGit } from "./runner-git"

/** Placement is a statement of where paths land, not a filesystem boundary. */
export async function runnerEnvironment(root: string, directories: readonly string[] = [], workingDirectory = root) {
  const signal = AbortSignal.timeout(5000)
  const values = await Promise.all(
    [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--git-common-dir"],
      ["rev-parse", "--git-dir"],
    ].map((args) =>
      runGit(workingDirectory, args, signal).then(
        (value) => value.stdout.trim(),
        () => undefined,
      ),
    ),
  )
  const branch = values[0] && values[0] !== "HEAD" ? values[0] : null
  const worktree =
    values[1] && values[2] ? resolve(workingDirectory, values[1]) !== resolve(workingDirectory, values[2]) : null
  return {
    root,
    directories: [...directories],
    working_directory: workingDirectory,
    platform: process.platform,
    branch,
    worktree,
    report: [
      "Relative paths resolve against " + root + ".",
      ...(workingDirectory !== root
        ? [
            "You are working in " +
              workingDirectory +
              ", which is NOT that directory — use absolute paths there, or pass workdir to bash.",
          ]
        : []),
      ...(directories.length ? ["Additional directories: " + directories.join(", ") + "."] : []),
      ...(branch ? ["Git branch: " + branch + "."] : []),
      ...(worktree ? ["This is a linked git worktree."] : []),
      "Absolute paths anywhere on this machine work; nothing is confined.",
    ].join("\n"),
  }
}
