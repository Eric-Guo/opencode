import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import type { RunnerTool } from "./extensions"
import type { mcpSession } from "./mcp-session"

type Session = Awaited<ReturnType<typeof mcpSession>>
type Input = Parameters<typeof mcpSession>[0]
type Held = Session & {
  workspace: string
  anchor: string
  digest: string
  candidates: RunnerTool[]
  validation: string[]
}

/** A registrar set belongs to the persisted environment anchor, including its inherited children. */
export class McpSessions {
  private readonly held = new Map<string, Held>()
  private configuration: RunnerTool["definition"][] = []

  constructor(
    private readonly boot: () => readonly RunnerTool[],
    private readonly open: (input: Input) => Promise<Session>,
    private readonly publish: () => Promise<void>,
    private readonly available: () => boolean = () => true,
  ) {}

  get(key: string) {
    this.refresh()
    return this.held.get(key)
  }

  values() {
    return this.held.values()
  }

  async close() {
    const sets = [...this.held.values()]
    this.held.clear()
    await Promise.allSettled(sets.map((set) => set.close()))
  }

  async bind(input: Input) {
    this.refresh()
    const key = JSON.stringify([input.workspace, input.conversation])
    const entries = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(input.servers)
    if (entries.length && !this.available())
      throw new Error("mcp_unavailable: enable the MCP extension before attaching editor servers.")
    const previous = this.held.get(key)
    const digest = mcpSessionDigest(entries)

    if (entries.length && previous?.digest === digest) return this.report(previous)

    // A replacement may bind the same process port: drain and close the old set before opening another.
    this.held.delete(key)
    await previous?.close()
    if (!entries.length) {
      if (previous) await this.publish()
      return { tools: [], issues: [] }
    }

    try {
      const candidate = await this.open({
        ...input,
        ledger: [
          ...this.boot().filter((tool) => tool.role === "agent"),
          ...[...this.held.values()].flatMap((row) => row.candidates),
        ].map((tool) => tool.definition),
      })
      if (!this.available()) {
        await candidate.close()
        throw new Error("mcp_unavailable: the MCP extension was unloaded while attaching editor servers.")
      }
      const held: Held = {
        ...candidate,
        workspace: input.workspace,
        anchor: input.conversation,
        digest,
        candidates: candidate.tools,
        validation: candidate.issues,
      }

      this.judge(held, this.boot(), [...this.held.values()])
      this.held.set(key, held)
      await this.publish()
      return this.report(held)
    } catch (error) {
      // A failed replacement cannot resurrect a closed predecessor.
      await this.publish().catch(() => {})
      throw error
    }
  }

  tools() {
    this.refresh()
    const names = new Map<string, RunnerTool>()

    for (const held of this.held.values())
      for (const tool of held.tools)
        if (!names.has(tool.definition.name))
          names.set(tool.definition.name, {
            ...tool,
            execute: (input, context) => {
              const key = JSON.stringify([context.workspace, context.anchor ?? context.conversation])
              const selected = this.get(key)?.tools.find((entry) => entry.definition.name === tool.definition.name)

              if (!selected) throw new Error("This MCP tool belongs to another environment anchor.")

              return selected.execute(input, context)
            },
          })

    return [...names.values()]
  }

  private report(held: Held) {
    return { tools: held.tools.map((tool) => tool.definition.name), issues: held.issues }
  }

  private refresh() {
    const boot = this.boot()
    const definitions = boot.map((tool) => tool.definition)
    if (isDeepStrictEqual(this.configuration, definitions)) return

    this.configuration = definitions
    const judged: Held[] = []
    for (const held of this.held.values()) {
      this.judge(held, boot, judged)
      judged.push(held)
    }
  }

  private judge(held: Held, boot: readonly RunnerTool[], others: readonly Held[]) {
    const faults = new Map<string, string>()
    for (const tool of held.candidates) {
      const row = tool.definition.mcp?.server_key
      if (!row) throw new Error(tool.definition.name + " carries no MCP server key.")

      const other = others.find((peer) =>
        peer.tools.some(
          (entry) =>
            entry.definition.name === tool.definition.name && !isDeepStrictEqual(entry.definition, tool.definition),
        ),
      )
      const owner = boot.some((entry) => entry.definition.name === tool.definition.name)
        ? "the boot table"
        : other
          ? "conversation " + other.anchor
          : undefined
      if (owner) faults.set(row, "name taken by " + owner)
    }

    held.tools = held.candidates.filter((tool) => !faults.has(tool.definition.mcp!.server_key))
    held.issues = [...held.validation, ...[...faults].map(([row, issue]) => row + ": " + issue)]
  }
}

/** Rho's environment gate deliberately excludes all environment/header values from its digest. */
export function mcpSessionDigest(entries: readonly Schema.Json[]) {
  const object = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))
  const facts = entries.map((entry) => {
    const parsed = object(entry)
    const row = parsed._tag === "Some" ? parsed.value : {}
    const pairs = row.env ?? row.headers
    const keys = Array.isArray(pairs)
      ? pairs
          .flatMap((pair) => {
            const parsed = object(pair)
            return parsed._tag === "Some" && typeof parsed.value.name === "string" ? [parsed.value.name] : []
          })
          .sort()
      : []

    return [
      Object.fromEntries(
        ["type", "name", "command", "args", "url"].filter((key) => key in row).map((key) => [key, row[key]]),
      ),
      keys,
    ]
  })

  return createHash("sha256").update(JSON.stringify(facts)).digest("hex")
}
