#!/usr/bin/env bun

import { setTimeout } from "node:timers/promises"
import { OpenCode } from "@opencode/client/promise"
import { Service } from "@opencode/client/service"
import { developmentHelp, parseDevelopment, runDevelopment } from "./terminal"

/** A source-only terminal for the enabled dev extension. Discovery never starts or replaces the service. */
export async function main(args = process.argv.slice(2)) {
  const parsed = parseDevelopment(args)

  if (parsed.verb === "help" || parsed.values.help) {
    process.stdout.write(developmentHelp)
    return 0
  }
  const endpoint = await Service.discover()

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
