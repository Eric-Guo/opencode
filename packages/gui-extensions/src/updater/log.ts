import { Effect, Layer, Logger, Predicate, References } from "effect"

import type { Log } from "../sdk/main"

/** Services for running the updater's effects: every log goes to the desktop log file, debug included. */
export function logContext(
  log: Log["write"],
) {
  const levels = new Map<string, Parameters<Log["write"]>[0]>([
    ["Trace", "debug"], ["Debug", "debug"], ["Info", "info"],
    ["Warn", "warn"], ["Error", "error"], ["Fatal", "error"],
  ])

  const logger = Logger.make((options) => {
    const entry = Logger.formatStructured.log(options)
    const [message, ...details] = Array.isArray(options.message) ? options.message : [options.message]
    const detail = details.length === 1 && Predicate.isObject(details[0]) && !Array.isArray(details[0]) ? details[0] : details.length ? { details } : {}
    const data: NonNullable<Parameters<Log["write"]>[2]> = { ...detail }

    if (Object.keys(entry.annotations).length) Object.assign(data, { annotations: entry.annotations })

    if (entry.cause !== undefined) Object.assign(data, { cause: entry.cause })
    log(levels.get(options.logLevel) ?? "info", String(message), data)
  })

  return Effect.runSync(
    Effect.context<never>().pipe(
      Effect.provide(
        Layer.merge(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "All"),
        ),
      ),
    ),
  )
}
