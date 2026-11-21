import { Schema } from "effect"
import type { AgentConfigurationInput, Client } from "@cybros/agent"
import type { ExtensionAgent } from "./extension-manager"
import { StoreDocument } from "./document"
import { summaryPrompt } from "./capabilities"

/** Extension definitions are application-owned identities, separate from editable Bots and Presets. */
export class RegisteredAgents {
  private readonly document

  constructor(private readonly member: Client) {
    this.document = new StoreDocument(
      member.profile.storeEntries,
      "opencode.extensions",
      "agents",
      Schema.decodeUnknownSync(Schema.mutable(Schema.Array(Schema.String))),
    )
  }

  async sync(definitions: readonly ExtensionAgent[], base: AgentConfigurationInput, summarizer = summaryPrompt) {
    const previous = (await this.document.read()) ?? []
    if (!definitions.length && !previous.length) return
    const existing = await this.member.profile.agents.list()
    for (const definition of definitions) {
      if (!previous.includes(definition.name) && existing.some((agent) => agent.name === definition.name))
        throw new Error("Extension agent name already belongs to another definition: " + definition.name)
    }
    // Save ownership before a declaration whose response may be lost; the next sync can reconcile it.
    await this.document.change(() => [...new Set([...previous, ...definitions.map((definition) => definition.name)])])
    for (const definition of definitions) {
      const configuration = {
        ...base,
        ...definition.configuration,
        // An omitted model inherits the request instead of fixing the installation default.
        default_model: definition.configuration.default_model ?? null,
      }

      await this.member.profile.agents.declare(definition.name, {
        scope: "instance",
        description: definition.description,
        display_name: definition.display_name,
        system_prompt: definition.system_prompt,
        configuration,
        summarizer: summarizer(configuration.compaction_policy),
      })
    }
    for (const name of previous.filter(
      (name) =>
        !definitions.some((definition) => definition.name === name) && existing.some((agent) => agent.name === name),
    ))
      await this.member.profile.agents.remove(name)
    await this.document.change(() => definitions.map((definition) => definition.name))
  }
}
