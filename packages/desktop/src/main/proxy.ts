import http from "node:http"
import type { Session } from "electron"

const LOOPBACK_BYPASS = ["127.0.0.1", "localhost", "::1"]

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv?: () => void
}

export type ElectronProxyConfig = {
  proxyRules: string
  proxyBypassRules: string
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

export function configureProxyCommandLine(
  commandLine: { appendSwitch: (switchName: string, value?: string) => void },
  env: Record<string, string | undefined> = process.env,
) {
  const config = getElectronProxyConfig(env)
  if (!config) return null

  commandLine.appendSwitch("proxy-server", config.proxyRules)
  commandLine.appendSwitch("proxy-bypass-list", config.proxyBypassRules)
  return config
}

export async function configureSessionProxy(session: Session, env: Record<string, string | undefined> = process.env) {
  const config = getElectronProxyConfig(env)
  if (!config) return null

  await session.setProxy({
    mode: "fixed_servers",
    proxyRules: config.proxyRules,
    proxyBypassRules: config.proxyBypassRules,
  })
  await session.forceReloadProxyConfig()
  return config
}

export function configureNodeProxyFromEnv(onError?: (error: unknown) => void) {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv?.()
  } catch (error) {
    onError?.(error)
  }
}
