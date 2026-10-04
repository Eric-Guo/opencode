import { Predicate } from "effect"

export function errorDescriptionKey(cause: unknown) {
  return Predicate.hasProperty(cause, "localServerStartup") && cause.localServerStartup === true
    ? ("error.page.description.localServerStartup" as const)
    : ("error.page.description" as const)
}

export function errorStatus(cause: unknown) {
  const seen = new Set<object>()

  const visit = (cause: unknown): number | undefined => {
    if (!Predicate.isObjectOrArray(cause) || seen.has(cause)) return
    seen.add(cause)

    for (const key of ["status", "statusCode"] as const) {
      const status = Predicate.hasProperty(cause, key) ? cause[key] : undefined

      if (Predicate.isNumber(status) && Number.isInteger(status) && status >= 100 && status <= 599) return status
    }

    return (
      visit(Predicate.hasProperty(cause, "cause") ? cause.cause : undefined) ??
      visit(Predicate.hasProperty(cause, "data") ? cause.data : undefined)
    )
  }

  return visit(cause)
}
