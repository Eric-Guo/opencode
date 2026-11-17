import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { EventEmitter } from "node:events"
import { constants } from "node:os"

// Node reaps children automatically. A live supervisor reserves the process-group ID
// after the command exits, until the registry has made its final group signal.
const supervisor = `
trap ':' TERM INT
(
  trap - TERM INT
  if [ "$2" != separate ]; then exec 2>&1; fi
  exec /bin/bash -c "$1" 3<&- 4>&-
) <&0 &
child=$!
printf 'pid %s\\n' "$child" >&4
exec 0</dev/null 1>/dev/null 2>/dev/null
while :; do
  wait "$child"
  result=$?
  kill -0 "$child" 2>/dev/null || break
done
printf 'exit %s\\n' "$result" >&4
while read -r -u 3 ignored; do
  [ "$ignored" = release ] && exit 0
done
kill -KILL -- -$$
`

export class OwnedProcess extends EventEmitter {
  readonly child: ChildProcess
  readonly output: Readable
  readonly stderr: Readable | null
  readonly exited: Promise<void>
  readonly started: Promise<void>
  pid = 0
  status: number | null = null
  signal: string | null = null
  leaderExited = false
  private released = false
  private killed = false

  constructor(
    command: string,
    directory: string,
    environment: NodeJS.ProcessEnv = process.env,
    separateStderr = false,
  ) {
    super()
    if (process.platform === "win32") throw new Error("Managed processes require a POSIX process-group host.")
    this.child = spawn(
      "/bin/bash",
      ["-c", supervisor, "nexus-process", command, separateStderr ? "separate" : "combined"],
      {
        cwd: directory,
        env: environment,
        detached: true,
        stdio: ["pipe", "pipe", separateStderr ? "pipe" : "ignore", "pipe", "pipe"],
      },
    )
    const output = this.child.stdout
    const status = this.child.stdio[4]
    if (!output || !(status instanceof Readable)) throw new Error("Could not open the process supervisor pipes.")
    this.output = output
    this.stderr = this.child.stderr
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.released = true
        if (!this.leaderExited) {
          this.leaderExited = true
          this.signal = this.child.signalCode?.replace(/^SIG/, "") ?? null
          this.status = this.child.exitCode
          this.emit("change")
        }
        resolve()
      })
      this.child.once("error", () => {
        this.released = true
        resolve()
      })
    })
    this.started = new Promise((resolve, reject) => {
      this.child.once("error", reject)
      this.child.once("exit", () => {
        if (!this.pid) reject(new Error("Process supervisor exited before starting the command."))
      })
      let pending = ""
      status.setEncoding("utf8")
      status.on("data", (chunk: string) => {
        pending += chunk
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          if (line.startsWith("pid ")) {
            this.pid = Number(line.slice(4))
            resolve()
          }
          if (!line.startsWith("exit ") || this.leaderExited) continue
          const code = Number(line.slice(5))
          this.leaderExited = true
          this.signal =
            code > 128
              ? (Object.entries(constants.signals)
                  .find(([, value]) => value === code - 128)?.[0]
                  .replace(/^SIG/, "") ?? null)
              : null
          this.status = this.signal ? null : code
          this.emit("change")
        }
      })
    })
  }

  get pgid() {
    return this.child.pid!
  }

  terminate(signal: NodeJS.Signals = "SIGTERM") {
    if (this.released || (signal === "SIGKILL" && this.killed)) return
    if (signal === "SIGKILL") this.killed = true
    try {
      process.kill(-this.pgid, signal)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")))
        throw error
    }
  }

  async close() {
    this.terminate("SIGKILL")
    await this.exited
    this.child.stdin?.destroy()
    const guard = this.child.stdio[3]
    if (guard instanceof Writable) guard.destroy()
  }

  async release() {
    const guard = this.child.stdio[3]
    if (!this.released && guard instanceof Writable) guard.write("release\n")
    await this.exited
    this.child.stdin?.destroy()
    if (guard instanceof Writable) guard.destroy()
  }
}
