import { Option, Predicate, Schema } from "effect"
import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, win32 } from "node:path"

type Logger = {
  log?: (message: string, meta?: { pid?: number; pidFile?: string; port?: number; uptimeSeconds?: number; version?: string; error?: string; stderr?: string; stdout?: string; platform?: NodeJS.Platform; command?: string }) => void
  warn?: (message: string, meta?: { pid?: number; pidFile?: string; port?: number; uptimeSeconds?: number; version?: string; error?: string; stderr?: string; stdout?: string; platform?: NodeJS.Platform; command?: string }) => void
}

type CommandResult = {
  stdout: string
  stderr: string
}

type CommandOptions = {
  timeout?: number
}

type Dependencies = {
  homeDir: string
  logger: Logger
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  access: (path: string) => Promise<void>
  execFile: (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>
  processRunning: (pid: number) => boolean
}

type EnsureOptions = {
  logger?: Logger
  dependencies?: Partial<Dependencies>
}

type DaemonStatus = {
  running: boolean
  port?: number
  version?: string
  uptime_seconds?: number
}

const commandTimeout = 5_000

const installTimeout = 120_000

export async function ensureKimiWebBridgeDaemon(options: EnsureOptions = {}) {
  const deps = createDependencies(options)
  const pidFile = joinPath(deps, deps.homeDir, ".kimi-webbridge", "daemon.pid")
  const pid = await readDaemonPid(pidFile, deps)
  const command = await ensureCommand(deps)

  if (!command) return

  const status = await readStatus(command, deps)

  if (status.running) {
    deps.logger.log?.("kimi-webbridge daemon already running", {
      pid: pid.value,
      pidFile,
      port: status.port,
      uptimeSeconds: status.uptime_seconds,
      version: status.version,
    })

    return
  }

  if (pid.running) {
    deps.logger.warn?.("kimi-webbridge daemon pid is active while status is not running; skipping start", {
      pid: pid.value,
      pidFile,
    })

    return
  }

  deps.logger.log?.("starting kimi-webbridge daemon", { pidFile })
  const started = await runCommand(command, ["start"], deps)

  if (!started.ok) {
    deps.logger.warn?.("failed to start kimi-webbridge daemon", {
      pidFile,
      error: started.error,
      stderr: started.stderr,
    })

    return
  }

  const nextStatus = await readStatus(command, deps)

  if (nextStatus.running) {
    deps.logger.log?.("kimi-webbridge daemon started", {
      pidFile,
      port: nextStatus.port,
      uptimeSeconds: nextStatus.uptime_seconds,
      version: nextStatus.version,
    })

    return
  }

  deps.logger.warn?.("kimi-webbridge daemon start command finished but status is not running", {
    pidFile,
    stdout: started.stdout,
    stderr: started.stderr,
  })
}

function createDependencies(options: EnsureOptions): Dependencies {
  return {
    homeDir: options.dependencies?.homeDir ?? homedir(),
    logger: options.logger ?? {},
    platform: options.dependencies?.platform ?? process.platform,
    readFile: options.dependencies?.readFile ?? ((path) => readFile(path, "utf8")),
    access: options.dependencies?.access ?? access,
    execFile: options.dependencies?.execFile ?? execFileUtf8,
    processRunning: options.dependencies?.processRunning ?? isProcessRunning,
  }
}

async function resolveCommand(deps: Dependencies) {
  const localBin = joinPath(deps, deps.homeDir, ".local", "bin", commandName(deps.platform))
  const installBin = joinPath(deps, deps.homeDir, ".kimi-webbridge", "bin", commandName(deps.platform))

  const candidates = [
    process.env.KIMI_WEBBRIDGE_BIN?.trim(),
    localBin,
    installBin,
  ].filter((candidate): candidate is string => Boolean(candidate))

  const available = await Promise.all(
    candidates.map((candidate) =>
      deps.access(candidate).then(
        () => candidate,
        () => undefined,
      ),
    ),
  )

  return available.find((candidate) => candidate !== undefined)
}

async function ensureCommand(deps: Dependencies) {
  const command = await resolveCommand(deps)

  if (command) return command

  const installer = installCommand(deps.platform)

  if (!installer) {
    deps.logger.warn?.("kimi-webbridge command not found and automatic install is unsupported", {
      platform: deps.platform,
    })

    return
  }

  deps.logger.log?.("installing kimi-webbridge", {
    platform: deps.platform,
  })
  const installed = await runCommand(installer.file, installer.args, deps, { timeout: installTimeout })

  if (!installed.ok) {
    deps.logger.warn?.("failed to install kimi-webbridge", {
      platform: deps.platform,
      error: installed.error,
      stderr: installed.stderr,
    })

    return
  }

  const nextCommand = await resolveCommand(deps)

  if (nextCommand) return nextCommand

  deps.logger.warn?.("kimi-webbridge install finished but command is still missing", {
    platform: deps.platform,
    stdout: installed.stdout,
    stderr: installed.stderr,
  })
}

function installCommand(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://cdn.kimi.com/webbridge/install.ps1 | iex",
      ],
    }
  }

  if (platform === "darwin") {
    return {
      file: "bash",
      args: ["-lc", "curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash"],
    }
  }
}

function commandName(platform: NodeJS.Platform) {
  return platform === "win32" ? "kimi-webbridge.exe" : "kimi-webbridge"
}

function joinPath(deps: Dependencies, ...paths: string[]) {
  if (deps.platform === "win32") return win32.join(...paths)

  return join(...paths)
}

async function readDaemonPid(pidFile: string, deps: Dependencies) {
  const content = await deps.readFile(pidFile).catch(() => undefined)
  const value = content ? Number.parseInt(content.trim(), 10) : undefined

  if (!value || Number.isNaN(value)) return { value: undefined, running: false }

  return { value, running: deps.processRunning(value) }
}

async function readStatus(command: string, deps: Dependencies): Promise<DaemonStatus> {
  const result = await runCommand(command, ["status"], deps)

  if (!result.ok) {
    deps.logger.warn?.("failed to read kimi-webbridge daemon status", {
      command,
      error: result.error,
      stderr: result.stderr,
    })

    return { running: false }
  }

  const parsed = parseStatus(result.stdout)

  if (parsed) return parsed

  deps.logger.warn?.("failed to parse kimi-webbridge daemon status", {
    command,
    stdout: result.stdout,
  })

  return { running: false }
}

async function runCommand(command: string, args: string[], deps: Dependencies, options?: CommandOptions) {
  return deps.execFile(command, args, options).then(
    (result) => ({ ok: true as const, stdout: result.stdout, stderr: result.stderr }),
    (error) => ({
      ok: false as const,
      stdout: commandErrorOutput(error, "stdout"),
      stderr: commandErrorOutput(error, "stderr"),
      error: serializeError(error),
    }),
  )
}


const Status = Schema.fromJsonString(Schema.Struct({
  running: Schema.Boolean,
  port: Schema.Unknown,
  version: Schema.Unknown,
  uptime_seconds: Schema.Unknown,
}).mapFields((fields) => ({
  ...fields,
  port: Schema.optionalKey(fields.port),
  version: Schema.optionalKey(fields.version),
  uptime_seconds: Schema.optionalKey(fields.uptime_seconds),
})))

function parseStatus(stdout: string): DaemonStatus | undefined {
  const status = Option.getOrUndefined(Schema.decodeUnknownOption(Status)(stdout))

  if (!status) return

  return {
    running: status.running,
    port: Predicate.isNumber(status.port) ? status.port : undefined,
    version: Predicate.isString(status.version) ? status.version : undefined,
    uptime_seconds: Predicate.isNumber(status.uptime_seconds) ? status.uptime_seconds : undefined,
  }
}

function execFileUtf8(file: string, args: string[], options?: CommandOptions) {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: options?.timeout ?? commandTimeout }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))

        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}


function commandErrorOutput(cause: unknown, key: "stdout" | "stderr") {
  if (!Predicate.isObject(cause)) return ""
  const output = key === "stdout" ? ("stdout" in cause ? cause.stdout : undefined) : ("stderr" in cause ? cause.stderr : undefined)

  if (Predicate.isString(output)) return output

  if (Buffer.isBuffer(output)) return output.toString("utf8")

  return ""
}

function serializeError(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
