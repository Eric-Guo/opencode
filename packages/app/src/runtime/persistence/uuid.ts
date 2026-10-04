import { Predicate } from "effect"

const fallback = () => Math.random().toString(16).slice(2)

export function uuid() {
  const c = globalThis.crypto

  if (!c || !Predicate.isFunction(c.randomUUID)) return fallback()

  if (Predicate.isBoolean(globalThis.isSecureContext) && !globalThis.isSecureContext) return fallback()

  try {
    return c.randomUUID()
  } catch {
    return fallback()
  }
}
