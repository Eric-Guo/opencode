import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { connect } from "node:net"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { scheduler } from "node:timers/promises"
import { which } from "@opencode/core/util/which"
import { missing } from "./storage"

/** One local foreground service per extension instance; assignments never own this process. */
export class T3Native {
  private child?: ChildProcess
  private stopped?: Promise<void>
  private readonly logins = new Map<
    string,
    { status: string; output: string; exit_code: number | null; abort: AbortController; finished: Promise<void> }
  >()

  constructor(
    readonly root: string,
    private readonly directory: string,
  ) {}

  async prepare() {
    await Promise.all(
      [this.root, join(this.root, "server", "userdata"), join(this.root, "codex"), join(this.root, "claude")].map(
        (path) => mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    )
    await writeFile(
      join(this.root, "server", "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          codex: {
            driver: "codex",
            enabled: true,
            config: { setupMode: "existing", binaryPath: "codex", homePath: join(this.root, "codex") },
          },
          claudeAgent: {
            driver: "claudeAgent",
            enabled: true,
            config: { binaryPath: "claude", homePath: join(this.root, "claude") },
          },
        },
      }),
      { mode: 0o600, flag: "wx" },
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return
      throw error
    })
  }

  private async environment() {
    const variables = [
      "HOME",
      "PATH",
      "LANG",
      "LC_ALL",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SystemRoot",
      "WINDIR",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "PATHEXT",
      "COMSPEC",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]
    const env = Object.fromEntries(
      variables.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
    )
    const path = join(this.root, "provider.env")
    const info = await stat(path).catch((error: unknown) => {
      if (missing(error)) return
      throw error
    })
    if (info) {
      if (
        !info.isFile() ||
        (process.platform !== "win32" && (info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())))
      )
        throw new Error("T3 provider.env must be owned by the service user and private (mode 0600 or stricter).")
      const content = await readFile(path, "utf8")
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        const match = /^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=(.*)$/.exec(line)
        if (!match) throw new Error("T3 provider.env accepts literal provider KEY=value lines only.")
        env[match[1]] = match[2]
      }
    }
    return {
      ...env,
      CODEX_HOME: join(this.root, "codex"),
      CLAUDE_CONFIG_DIR: join(this.root, "claude"),
      ANTHROPIC_CONFIG_DIR: join(this.root, "claude", "anthropic"),
    }
  }

  running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }

  installed() {
    return Object.fromEntries(["t3", "codex", "claude"].map((name) => [name, which(name) !== null]))
  }

  async start(port: number, signal: AbortSignal) {
    if (this.running()) return
    await this.prepare()
    if (await listening(port)) throw new Error("The local T3 port is already in use; select another port.")
    const child = spawn(
      "t3",
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", join(this.root, "server")],
      {
        cwd: this.directory,
        env: await this.environment(),
        stdio: "ignore",
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    )
    this.child = child
    this.stopped = new Promise((resolve) => {
      child.once("exit", () => resolve())
      child.once("error", () => resolve())
    })
    const errors: Error[] = []
    child.once("error", (error) => errors.push(error))
    const abort = () => {
      void this.close()
    }
    signal.addEventListener("abort", abort, { once: true })
    const deadline = Date.now() + 15000
    try {
      while (true) {
        signal.throwIfAborted()
        if (errors.length || !this.running())
          throw new Error("The local T3 executable is unavailable or exited during startup.")
        if (await listening(port)) return
        if (Date.now() >= deadline) throw new Error("The local T3 service did not start before its deadline.")
        await scheduler.wait(50, { signal })
      }
    } catch (error) {
      await this.close()
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }

  async close() {
    for (const login of this.logins.values()) login.abort.abort()
    await Promise.all([...this.logins.values()].map((login) => login.finished))
    const child = this.child
    this.child = undefined
    if (!child?.pid) return
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        })
        taskkill.once("exit", () => resolve())
        taskkill.once("error", () => {
          child.kill()
          resolve()
        })
      })
      await this.stopped
      return
    }
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    kill("SIGTERM")
    const timer = setTimeout(() => kill("SIGKILL"), 2000)
    try {
      await this.stopped
    } finally {
      clearTimeout(timer)
    }
  }

  async token(signal: AbortSignal) {
    await this.prepare()
    const result = await this.command(
      "t3",
      ["auth", "session", "issue", "--base-dir", join(this.root, "server"), "--label", "opencode", "--token-only"],
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    )
    const token = result.stdout.trim()
    if (result.code !== 0 || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new Error("Native T3 bearer issuance failed; inspect the native installation.")
    return token
  }

  async login(provider: string, apiKey: string | undefined, signal: AbortSignal) {
    if (!["codex", "claude"].includes(provider)) throw new Error("Choose codex or claude for native login.")
    if (provider === "claude" && apiKey)
      throw new Error("Configure ANTHROPIC_API_KEY in the private provider environment file.")
    await this.prepare()
    const id = crypto.randomUUID()
    const state = {
      status: "running",
      output: "",
      exit_code: null as number | null,
      abort: new AbortController(),
      finished: Promise.resolve(),
    }
    this.logins.set(id, state)
    state.finished = this.command(
      provider,
      provider === "codex"
        ? ["-c", 'cli_auth_credentials_store="file"', "login", apiKey ? "--with-api-key" : "--device-auth"]
        : ["auth", "login"],
      apiKey,
      AbortSignal.any([signal, state.abort.signal, AbortSignal.timeout(600000)]),
      (text) => {
        state.output = (state.output + text).slice(-65536)
      },
    ).then(
      (result) => {
        state.exit_code = result.code
        state.status = result.code === 0 ? "completed" : "failed"
      },
      () => {
        state.status = state.abort.signal.aborted ? "canceled" : "failed"
      },
    )
    return this.loginStatus(id)
  }

  loginStatus(id: string) {
    const login = this.logins.get(id)
    if (!login) throw new Error("Unknown native login session.")
    return { login_id: id, status: login.status, output: login.output, exit_code: login.exit_code }
  }

  private async command(
    command: string,
    args: string[],
    input: string | undefined,
    signal: AbortSignal,
    outputChanged?: (text: string) => void,
  ) {
    signal.throwIfAborted()
    const child = spawn(command, args, {
      cwd: this.directory,
      env: await this.environment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    const output = { stdout: "", stderr: "" }
    child.stdout?.on("data", (chunk: Buffer) => {
      output.stdout = (output.stdout + chunk.toString()).slice(-65536)
      outputChanged?.(chunk.toString())
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      output.stderr = (output.stderr + chunk.toString()).slice(-65536)
      outputChanged?.(chunk.toString())
    })
    child.stdin?.end(input ? input + "\n" : undefined)
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return
      if (process.platform === "win32") {
        const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        })
        taskkill.once("error", () => {
          child.kill(kind)
        })
        return
      }
      try {
        process.kill(-child.pid, kind)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      kill("SIGTERM")
      timer = setTimeout(() => kill("SIGKILL"), 2000)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => resolve(code ?? 1))
      })
      signal.throwIfAborted()
      return { ...output, code }
    } finally {
      signal.removeEventListener("abort", abort)
      clearTimeout(timer)
    }
  }
}

function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    const finish = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(100, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}
