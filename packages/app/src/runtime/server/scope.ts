import type { ServerConnection } from "@/runtime/server/registry"

export type ServerScope = string & { readonly __brand: "ServerScope" }

export type SessionRouteKey = string & { readonly __brand: "SessionRouteKey" }

export type SessionStateKey = string & { readonly __brand: "SessionStateKey" }

export type ScopedKey = string & { readonly __brand: "ScopedKey" }

const separator = "\u0000"

function fragment(label: string, value: string) {
  if (value.includes(separator)) throw new Error(`${label} cannot contain null bytes`)

  return value
}

function compose(scope: ServerScope, parts: string[]) {
  return [fragment("Server scope", scope), ...parts.map((part) => fragment("Scoped key part", part))].join(separator)
}

export const ServerScope = {
  // SAFETY: the canonical local scope is a reserved separator-free server identifier.
  local: "local" as ServerScope,
  fromServerKey(key: ServerConnection.Key, canonicalLocalServer?: ServerConnection.Key) {
    // SAFETY: fragment rejects separator bytes before branding the single scope or route component.
    return fragment(
      "Server scope",
      key === "sidecar" || key === canonicalLocalServer ? ServerScope.local : key,
    ) as ServerScope
  },
}

export const SessionRouteKey = {
  fromRoute(dir: string | undefined, sessionID?: string) {
    // SAFETY: fragment rejects separator bytes before branding the single scope or route component.
    return fragment("Session route", `${dir ?? ""}${sessionID ? "/" + sessionID : ""}`) as SessionRouteKey
  },
}

export const SessionStateKey = {
  is(key: string): key is SessionStateKey {
    return key.includes(separator)
  },
  from(scope: ServerScope, route: SessionRouteKey) {
    // SAFETY: compose validates each component and inserts the required server separator.
    return compose(scope, [route]) as SessionStateKey
  },
  route(key: string) {
    const split = key.lastIndexOf(separator)

    if (split === -1) throw new Error("Session state key must include server scope")

    // SAFETY: fragment rejects separator bytes before branding the single scope or route component.
    return fragment("Session route", key.slice(split + 1)) as SessionRouteKey
  },
  scope(key: string) {
    const split = key.indexOf(separator)

    if (split === -1) throw new Error("Session state key must include server scope")

    // SAFETY: fragment rejects separator bytes before branding the single scope or route component.
    return fragment("Stored server scope", key.slice(0, split)) as ServerScope
  },
}

export const ScopedKey = {
  from(scope: ServerScope, ...parts: string[]) {
    // SAFETY: compose validates each key component and inserts separators between them.
    return compose(scope, parts) as ScopedKey
  },
  prefix(scope: ServerScope, ...parts: string[]) {
    return `${ScopedKey.from(scope, ...parts)}${separator}`
  },
}
