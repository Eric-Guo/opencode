import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { DEFAULT_SERVER_URL_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { type WslCommandLine, resolveWslOpencode, shellEscape, wslArgs } from "./wsl"

export type HealthCheck = { wait: Promise<void> }

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export async function allocatePort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export async function spawnLocalServer(hostname: string, port: number, password: string) {
  prepareServerEnv(password)
  const { Log, Server } = await import("virtual:opencode-server")
  await Log.init({ level: "WARN" })
  const listener = await Server.listen({
    port,
    hostname,
    username: "opencode",
    password,
    cors: ["oc://renderer"],
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) return
      }
    }

    await ready()
  })()

  return { listener, health: { wait } }
}

export type WslSidecar = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}

export async function spawnWslSidecar(
  distro: string,
  opts: { onLine?: (line: WslCommandLine) => void; healthTimeoutMs?: number } = {},
): Promise<WslSidecar> {
  // Do not pass --user here: the sidecar should inherit the distro's
  // default user so config, auth, git, ssh, and file ownership match the
  // user's normal WSL environment. If that default user is root, WSL will
  // choose root itself.
  const opencode = await resolveWslOpencode(distro)
  if (!opencode) throw new Error(`OpenCode is not installed in ${distro}`)

  const port = await allocatePort()
  const password = randomUUID()
  const username = "opencode"
  const logLevel = app.isPackaged ? "WARN" : "INFO"

  const script = [
    "set -euo pipefail",
    // wsl.exe inherits the Windows-side cwd (e.g. C:\Users\Lukem) and maps it
    // to the distro as /mnt/c/Users/Lukem — a DrvFs/9p path. opencode's
    // instance middleware falls back to `process.cwd()` when a request
    // arrives without a `directory=` query or `x-opencode-directory` header
    // (see opencode server.ts InstanceMiddleware), and then calls
    // `realpathSync(process.cwd())` synchronously on the main thread. A
    // statx against a 9p path can wedge the whole event loop in kernel
    // uninterruptible sleep, freezing the accept loop. Move cwd to the
    // user's native Linux home so the fallback can't land on DrvFs.
    'cd "$HOME" || cd /',
    // wsl.exe by default splices the Windows %PATH% into the distro's $PATH
    // via the interop layer (every `/mnt/c/Program Files/...` entry). Anything
    // the sidecar spawns — PTY login shells, plugin helpers, etc. — then
    // inherits it, which means `which pwsh.exe` resolves to the Windows
    // PowerShell binary and bash-l profiles that end with
    //   eval "$(oh-my-posh init bash)"   (or similar)
    // silently run Windows pwsh for prompt rendering, whose banner
    // ("Loading personal and system profiles took Xms.") then shows up in
    // opencode's terminal pane. We want a clean, Linux-only environment in
    // the sidecar, so filter every /mnt/* segment out of PATH and clear
    // WSLENV so no further Windows vars leak in. Users who really need
    // Windows binaries in the sidecar can invoke them by absolute path.
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    "export WSLENV=",
    // WSL sidecars often target /mnt/* worktrees. Keep the desktop-only
    // watcher/discovery features off there because DrvFs/9p stalls can wedge
    // the server process after it starts listening.
    "export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
    "export OPENCODE_CLIENT=desktop",
    `export OPENCODE_SERVER_USERNAME=${shellEscape(username)}`,
    `export OPENCODE_SERVER_PASSWORD=${shellEscape(password)}`,
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `exec ${shellEscape(opencode)} --print-logs --log-level ${logLevel} serve --hostname 0.0.0.0 --port ${port}`,
  ].join("\n")

  const child = spawn("wsl", wslArgs(["bash", "-se"], distro), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdin.end(script)

  let settled = false
  const recentOutput: string[] = []
  const emit = (line: WslCommandLine) => {
    if (settled || !line.text.trim()) return
    recentOutput.push(`[${line.stream}] ${line.text}`)
    if (recentOutput.length > 12) recentOutput.shift()
    opts.onLine?.(line)
  }

  forwardLines(child.stdout, "stdout", emit)
  forwardLines(child.stderr, "stderr", emit)

  const exit = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      reject(new Error(startupFailure(code, signal, recentOutput)))
    })
  })

  const url = `http://127.0.0.1:${port}`
  const healthPromise = (async () => {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (await checkHealth(url, password)) return
    }
  })()

  const timeoutMs = opts.healthTimeoutMs ?? 30_000
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(
      () => reject(new Error(`Sidecar for ${distro} health check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    void healthPromise.finally(() => clearTimeout(id))
  })

  try {
    await Promise.race([healthPromise, exit, timeout])
  } catch (error) {
    child.kill()
    throw error
  } finally {
    settled = true
  }

  return {
    listener: {
      stop() {
        child.kill()
      },
      onExit(cb) {
        child.once("exit", cb)
      },
    },
    url,
    username,
    password,
  }
}

function prepareServerEnv(password: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const env = {
    ...process.env,
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: app.getPath("userData"),
  }
  Object.assign(process.env, env)
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  source: WslCommandLine["stream"],
  onLine: (line: WslCommandLine) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    pending = lines.pop() ?? ""
    for (const line of lines) onLine({ stream: source, text: line })
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null, recentOutput: string[]) {
  const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
  return `WSL server exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"})${suffix}`
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
