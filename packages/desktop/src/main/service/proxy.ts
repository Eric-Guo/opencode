import type { EnsureOptions } from "@opencode/client/service"
import type { createProxySettings } from "../proxy-settings"

/** Replace the old process once, before acknowledging the launch's proxy preference. */
export async function ensureProxyService(
  proxy: ReturnType<typeof createProxySettings>,
  options: EnsureOptions,
  mode: "initial" | "reconnect",
) {
  const { Service } = await import("@opencode/client/service")

  if (mode === "initial" && proxy.pending()) await Service.stop({ file: options.file, pty: "handoff" })
  const service = await Service.ensure(options)

  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")

  if (mode === "initial") proxy.applied()

  return { ...service, auth: service.auth }
}
