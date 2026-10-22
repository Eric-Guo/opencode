import http from "node:http"
import type { ProxyConfig, Session } from "electron"
import type { DesktopProxySettings } from "../extension"

const LOOPBACK_BYPASS = ["127.0.0.1", "localhost", "::1"]

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv?: (env: Record<string, string | undefined>) => () => void
}

export type ElectronProxyConfig = {
  proxyRules: string
  proxyBypassRules: string
}

export function getProxyEnvironment(settings: DesktopProxySettings, env: Record<string, string | undefined>) {
  const bypass = settings.mode === "manual" ? settings.bypass : readEnv(env, "no_proxy")

  const noProxy = [
    ...new Set([
      ...(settings.mode === "direct" ? "*" : (bypass ?? ""))
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean),
      ...LOOPBACK_BYPASS,
      "[::1]",
    ]),
  ].join(",")

  return Object.fromEntries(
    ["http_proxy", "https_proxy", "all_proxy", "ws_proxy", "wss_proxy", "no_proxy"].flatMap((key) => {
      const value =
        key === "no_proxy"
          ? noProxy
          : settings.mode === "manual"
            ? settings.url
            : settings.mode === "direct"
              ? ""
              : (readEnv(env, key) ?? "")

      return [
        [key, value],
        [key.toUpperCase(), value],
      ]
    }),
  )
}

export function getSessionProxyConfig(
  settings: DesktopProxySettings,
  env: Record<string, string | undefined>,
): ProxyConfig {
  if (settings.mode === "direct") return { mode: "direct" }
  const config = getElectronProxyConfig(env)

  if (!config) return { mode: "system" }

  return {
    mode: "fixed_servers",
    ...config,
    proxyRules: settings.mode === "manual" ? settings.url : config.proxyRules,
  }
}

export function createSessionProxy(config: ProxyConfig) {
  const pending = new WeakMap<Session, Promise<void>>()

  return (session: Session) => {
    const previous = pending.get(session)

    if (previous) return previous

    const ready = session
      .setProxy(config)
      .then(() => session.forceReloadProxyConfig())
      .catch((error) => {
        pending.delete(session)
        throw error
      })

    pending.set(session, ready)

    return ready
  }
}

function readEnv(env: Record<string, string | undefined>, key: string) {
  for (const candidate of [key.toLowerCase(), key.toUpperCase()]) {
    const value = env[candidate]

    if (!value) continue
    const trimmed = value.trim()

    if (trimmed) return trimmed
  }

  return undefined
}

function normalizeBypassRule(rule: string) {
  if (rule === "*" || rule.startsWith("*") || !rule.startsWith(".")) return rule

  return `*${rule}`
}

export function getProxyBypassRules(env: Record<string, string | undefined> = process.env) {
  const items = new Set<string>()
  const raw = readEnv(env, "no_proxy")

  if (raw) {
    for (const item of raw.split(/[;,]/)) {
      const rule = normalizeBypassRule(item.trim())

      if (rule) items.add(rule)
    }
  }

  for (const host of LOOPBACK_BYPASS) {
    items.add(host)
  }

  return [...items]
}

function getProxyScheme(value: string) {
  const match = value.match(/^([a-z0-9+.-]+):\/\//i)

  return match?.[1]?.toLowerCase() ?? null
}

export function getElectronProxyConfig(
  env: Record<string, string | undefined> = process.env,
): ElectronProxyConfig | null {
  const httpProxy = readEnv(env, "http_proxy")
  const httpsProxy = readEnv(env, "https_proxy")
  const allProxy = readEnv(env, "all_proxy")

  if (!httpProxy && !httpsProxy && !allProxy) return null

  const proxyBypassRules = getProxyBypassRules(env).join(";")

  if (!httpProxy && !httpsProxy && allProxy) {
    return {
      proxyRules: allProxy,
      proxyBypassRules,
    }
  }

  const rules: string[] = []
  const resolvedHttp = httpProxy ?? allProxy
  const resolvedHttps = httpsProxy ?? allProxy

  if (resolvedHttp) rules.push(`http=${resolvedHttp}`)

  if (resolvedHttps) rules.push(`https=${resolvedHttps}`)

  if (allProxy && (httpProxy || httpsProxy) && getProxyScheme(allProxy)?.startsWith("socks")) {
    rules.push(`socks=${allProxy}`)
  }

  return {
    proxyRules: rules.join(";"),
    proxyBypassRules,
  }
}

export function configureNodeProxyFromEnv(env: Record<string, string | undefined> = process.env) {
  // SAFETY: The shipped Node/Electron runtime exposes this newer API ahead of @types/node.
  const configure = (http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv

  if (!configure) throw new Error("The Node runtime does not support environment proxies")

  return configure(env)
}
