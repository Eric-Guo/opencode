#!/usr/bin/env bun

import { setTimeout } from "node:timers/promises"
import { OpenCode } from "@opencode/client/promise"
import { $, Glob, which } from "bun"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import { Service, fallback, type Endpoint } from "@opencode/client/service"
import { developmentHelp, formatAdaptationInspection, parseDevelopment, runDevelopment } from "./terminal"

/** A source-only terminal for the enabled dev extension. Discovery never starts or replaces the service. */
export async function main(args = process.argv.slice(2)) {
  const parsed = parseDevelopment(args)

  if (parsed.verb === "help" || parsed.values.help) {
    process.stdout.write(developmentHelp)
    return 0
  }
  const endpoint = await installedService()

  if (!endpoint && parsed.verb === "adaptations") {
    const { Global } = await import("@opencode/util/global")
    const { Adaptations } = await import("../src/adaptations")
    const { ApplicationSettings, readConnectionSettings } = await import("../src/settings")
    const storage = join(Global.Path.data, "nexus-runtime")
    const settings = new ApplicationSettings(join(storage, "application-settings.json"))
    await settings.restore()

    const values = settings.read()
    const boot = values.default_model ?? (await readConnectionSettings(storage))?.model
    const pack = await Adaptations.load(values, storage, boot)
    const model = parsed.text("model") ?? boot
    process.stdout.write(
      formatAdaptationInspection(
        {
          model: model ?? null,
          adaptations: pack.facts(model),
          facts: null,
          catalog_error: "OpenCode service offline",
        },
        parsed.values.json === true,
      ),
    )
    return 0
  }
  if (!endpoint)
    throw new Error("No elected OpenCode service is available. Start OpenCode before using development controls.")

  const nexus = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).experimental.nexus
  const owner = new AbortController()
  const cancel = () => owner.abort()

  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    const deadline = performance.now() + 30000

    while (!owner.signal.aborted) {
      const extension = (await nexus.extensions({ signal: owner.signal })).find((row) => row.id === "nexus.dev")

      if (!extension)
        throw new Error(
          "Load packages/nexus-runtime/dev/extension.ts through OPENCODE_NEXUS_EXTENSIONS to enable source-only development controls.",
        )
      if (!extension.enabled) throw new Error("Enable nexus.dev before using development controls.")
      if (extension.active) break
      if (extension.diagnostics.length || performance.now() >= deadline)
        throw new Error(extension.diagnostics.join("\n") || "The development extension did not activate.")

      await setTimeout(50, undefined, { signal: owner.signal })
    }
    const status = await nexus.status({ signal: owner.signal })
    const workspace = status.identity?.workspace ?? status.workspace

    return await runDevelopment(args, {
      signal: owner.signal,
      extension: (name, input) =>
        nexus.manage({ payload: { action: "extension.call", name, input } }, { signal: owner.signal }),
      command: (input) =>
        nexus.manage(
          { payload: { action: "extension.call", name: "dev", input } },
          { signal: input.action === "stream.close" ? undefined : owner.signal },
        ),
      read: async () => {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
        return Buffer.concat(chunks).toString("utf8")
      },
      write: (value) => {
        process.stdout.write(value)
      },
      error: (value) => {
        process.stderr.write(value)
      },
      modes: async (conversation, patch) => {
        await nexus.modes({ workspace, conversation, patch }, { signal: owner.signal })
      },
    })
  } catch (error) {
    if (owner.signal.aborted) return 130

    throw error
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

async function installedService(): Promise<Endpoint | undefined> {
  const binary = which("opencode")
  if (!binary) return Service.discover()

  const status = await $`${binary} service status`.quiet().nothrow()
  if (status.exitCode !== 0) return
  const url = status.text().trim()
  if (!URL.canParse(url)) return
  const elected = Schema.is(Schema.Struct({ url: Schema.Literal(url) }))

  // The config directory may be overridden independently of the elected registration.
  // Let the SDK verify the running owner and use the credential that owner published.
  for await (const file of new Glob("service{,-*}.json").scan({ cwd: dirname(fallback()), absolute: true })) {
    const matches = await Bun.file(file)
      .json()
      .then(elected, () => false)
    if (!matches) continue
    const endpoint = await Service.discover({ file })
    if (endpoint?.url === url) return endpoint
  }
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n")
      process.exitCode = 1
    },
  )
}
