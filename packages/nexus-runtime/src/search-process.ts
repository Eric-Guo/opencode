import { spawn } from "node:child_process"
import { once } from "node:events"
import { OwnedProcess } from "./owned-process"

/** Searches own their process tree, even after a wrapper's leader has exited. */
export async function searchProcess(
  command: string,
  args: string[],
  directory: string,
  signal: AbortSignal,
  separator: number,
) {
  signal.throwIfAborted()
  const owned =
    process.platform === "win32"
      ? undefined
      : new OwnedProcess(
          [command, ...args].map((word) => "'" + word.replaceAll("'", "'\\''") + "'").join(" "),
          directory,
          process.env,
          true,
        )
  const child =
    owned?.child ?? spawn(command, args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  const stdout = owned?.output ?? child.stdout!
  const stderr = owned?.stderr ?? child.stderr!
  const exited = owned
    ? owned.started.then(async () => {
        if (!owned.leaderExited) await once(owned, "change")
        return owned.status
      })
    : new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", resolve)
      })
  let diagnostic = Buffer.alloc(0)
  let diagnosticBytes = 0
  stderr.on("data", (chunk: Buffer) => {
    diagnosticBytes += chunk.length
    if (diagnostic.length < 51200) diagnostic = Buffer.concat([diagnostic, chunk]).subarray(0, 51200)
  })
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      if (owned) await owned.close()
      if (!owned) {
        child.kill()
        await exited.catch(() => {})
      }
      // A detached descendant may retain a pipe after the owned group is gone.
      const timer = setTimeout(() => {
        stdout.destroy()
        stderr.destroy()
      }, 1000)
      try {
        await Promise.all(
          [stdout, stderr].map((stream) => (stream.closed ? undefined : once(stream, "close").catch(() => {}))),
        )
      } finally {
        clearTimeout(timer)
      }
    })())
  const abort = () => {
    void close()
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  child.stdin?.end()
  const result = exited.then(async (status) => {
    await close()
    return {
      status,
      stderr: diagnostic.toString().trim() + (diagnosticBytes > 51200 ? "\n[stderr truncated after 51200 bytes]" : ""),
    }
  })
  void result.catch(() => {})
  return {
    result,
    async *records() {
      let prefix = Buffer.alloc(0)
      let overflow = false
      try {
        for await (const chunk of stdout) {
          signal.throwIfAborted()
          const bytes = Buffer.from(chunk)
          let at = 0
          while (at < bytes.length) {
            const end = bytes.indexOf(separator, at)
            const part = bytes.subarray(at, end < 0 ? bytes.length : end)
            if (prefix.length + part.length > 51200) overflow = true
            if (!overflow) prefix = Buffer.concat([prefix, part])
            if (end >= 0) {
              yield { content: prefix, overflow }
              prefix = Buffer.alloc(0)
              overflow = false
            }
            at = end < 0 ? bytes.length : end + 1
          }
        }
        if (prefix.length || overflow) yield { content: prefix, overflow }
        await exited
      } catch (error) {
        signal.throwIfAborted()
        // Closing inherited pipes after leader exit can interrupt the iterator.
        if (!closing) throw error
      } finally {
        await close()
        signal.removeEventListener("abort", abort)
      }
      signal.throwIfAborted()
    },
  }
}
