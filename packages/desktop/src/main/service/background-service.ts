import { Service } from "@opencode-ai/client/service"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import { cliInstallPath } from "../cli-install"
import { parseCliVersion } from "./cli-version"
import { developmentResourcesRoot } from "../paths"

const execFileAsync = promisify(execFile)
type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export async function startBackgroundCli(logger: Logger, options: { cors?: string[] } = {}) {
  const isolated = !app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1"
  const development = !app.isPackaged && process.env.OPENCODE_DESKTOP_CLI_DEV
  const developmentVersion = process.env.OPENCODE_VERSION ?? "local"
  const cli = development
    ? {
        version: developmentVersion,
        command: [
          "bun",
          "run",
          "--cwd",
          development,
          `--define=OPENCODE_VERSION=${JSON.stringify(developmentVersion)}`,
          "src/index.ts",
        ],
        binary: undefined,
      }
    : await resolveBundledCli(isolated, logger)
  if (isolated) process.env.XDG_STATE_HOME = app.getPath("userData")
  if (options.cors)
    await run(cli.command[0], [...cli.command.slice(1), "service", "set", "cors", JSON.stringify(options.cors)], logger)
  const service = await Service.ensure({
    file:
      isolated && process.env.OPENCODE_DESKTOP_SERVER_CHANNEL === "local"
        ? join(app.getPath("userData"), "opencode", "service-local.json")
        : undefined,
    version: cli.version,
    command: [...cli.command, "serve", "--service", ...(isolated ? ["--port", "0"] : [])],
    onStart: (reason, previousVersion) => logger.log("v2 CLI background service starting", { reason, previousVersion }),
  })
  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")
  logger.log("v2 CLI background service ready", {
    username: service.auth.username,
    version: cli.version,
    ...endpoint(service.url),
  })
  if (isolated && cli.binary) await cleanCliStages(cli.binary, logger)
  return {
    url: service.url,
    username: service.auth.username,
    password: service.auth.password,
    version: cli.version,
    wslBuild:
      app.isPackaged || !process.env.OPENCODE_DESKTOP_WSL_CLI_BUILD || !process.env.OPENCODE_DESKTOP_WSL_CLI_OUTPUT
        ? undefined
        : {
            script: process.env.OPENCODE_DESKTOP_WSL_CLI_BUILD,
            output: process.env.OPENCODE_DESKTOP_WSL_CLI_OUTPUT,
          },
  }
}

async function resolveBundledCli(isolated: boolean, logger: Logger) {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, executableName())
    : join(developmentResourcesRoot, isolated ? developmentExecutableName() : executableName())
  logger.log("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
  const version = parseCliVersion(await run(bundled, ["--version"], logger))
  logger.log("v2 CLI executable verified", { version })
  const binary = app.isPackaged
    ? await installCli(bundled, app.getVersion(), version, logger)
    : isolated
      ? await installCli(bundled, version, version, logger)
      : bundled
  return { version, binary, command: [binary] }
}

async function cleanCliStages(binary: string, logger: Logger) {
  const current = dirname(binary)
  const root = dirname(current)
  await Promise.all(
    (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && join(root, entry.name) !== current)
      .map((entry) =>
        rm(join(root, entry.name), { recursive: true, force: true }).catch((error) =>
          logger.error("failed to clean staged v2 CLI", { path: join(root, entry.name), error }),
        ),
      ),
  )
}

async function installCli(source: string, version: string, cliVersion: string, logger: Logger) {
  const preferred = app.isPackaged
    ? cliInstallPath(app.getPath("userData"), version)
    : join(app.getPath("userData"), "cli", version.replace(/[^a-zA-Z0-9._-]/g, "-"), executableName())
  const installed = existsSync(preferred)
  const installedVersion = installed
    ? await execFileAsync(preferred, ["--version"], { windowsHide: true }).then(
        (result) => parseCliVersion(result.stdout.trim()),
        () => undefined,
      )
    : undefined
  const destination =
    app.isPackaged && installed && installedVersion !== cliVersion
      ? cliInstallPath(app.getPath("userData"), `${version}-${cliVersion}`)
      : preferred
  if (destination !== preferred)
    logger.log("v2 CLI staged executable version differs", {
      path: preferred,
      installedVersion,
      bundledVersion: cliVersion,
      replacement: destination,
    })
  if (existsSync(destination)) {
    logger.log("v2 CLI staged executable reused", { path: destination, version })
    return destination
  }

  const temp = destination + `.${process.pid}.tmp`
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, temp)
  if (process.platform !== "win32") await chmod(temp, 0o755)
  await rename(temp, destination).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
  logger.log("v2 CLI executable staged", { source, path: destination, version })
  return destination
}

async function run(binary: string, args: string[], logger: Logger) {
  logger.log("v2 CLI command started", { binary, args })
  return execFileAsync(binary, args, { windowsHide: true }).then(
    (result) => {
      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()
      logger.log("v2 CLI command completed", { args, stdout, stderr })
      return stdout
    },
    (error: unknown) => {
      const output = error as { stdout?: string; stderr?: string }
      logger.error("v2 CLI command failed", {
        args,
        error: error instanceof Error ? error.message : String(error),
        stdout: output.stdout?.trim() ?? "",
        stderr: output.stderr?.trim() ?? "",
      })
      throw error
    },
  )
}

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)
  return { url, hostname: parsed.hostname, port: parsed.port }
}

function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}

function developmentExecutableName() {
  return process.platform === "win32" ? "opencode-cli-dev.exe" : "opencode-cli-dev"
}
