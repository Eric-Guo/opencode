import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { configureNodeProxyFromEnv } from "./proxy"

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
}

type SidecarCommand = StartCommand | { type: "stop" }

type SidecarMessage =
  | { type: "starting"; stage: string }
  | { type: "diagnostic"; message: string }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type ServerModule = {
  Server: {
    listen(options: {
      port: number
      hostname: string
      password: string
      cors: string[]
    }): Promise<{ stop(close?: boolean): void | Promise<void> }>
  }
}

const parentPort = getParentPort()
const state = { listener: undefined as Awaited<ReturnType<ServerModule["Server"]["listen"]>> | undefined }

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  const diagnostic = setInterval(() => {
    parentPort.postMessage({
      type: "diagnostic",
      message: `sidecar event loop responsive; active resources: ${process.getActiveResourcesInfo().join(", ")}`,
    })
  }, 10_000)
  try {
    parentPort.postMessage({ type: "starting", stage: "preparing environment" })
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    parentPort.postMessage({ type: "starting", stage: "loading server module" })
    const opencode = (await import(new URL("./chunks/sidecar.mjs", import.meta.url).href)) as ServerModule

    parentPort.postMessage({ type: "starting", stage: "starting server" })
    state.listener = await opencode.Server.listen({
      port: command.port,
      hostname: command.hostname,
      password: command.password,
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  } finally {
    clearInterval(diagnostic)
  }
}

async function stop() {
  try {
    await state.listener?.stop()
  } finally {
    state.listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_STARTUP_TRACE: "1",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)

    loopback.forEach((host) => {
      if (items.some((value) => value.toLowerCase() === host)) return
      items.push(host)
    })
    process.env[key] = items.join(",")
  }
  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  configureNodeProxyFromEnv((error) => console.warn("failed to load proxy environment", error))
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | { type: "stop" }>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
