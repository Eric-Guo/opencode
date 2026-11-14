import { Toolsets } from "@cybros/agent"
import type { Nexus } from "@opencode/schema/nexus"
import type { ExtensionModule } from "./extension-manager"

export const compactionInstructions = `You are summarizing the earlier part of a coding agent's conversation so the agent can continue with less context. The history below is what happened; the retained tail is what the agent will still see verbatim after your summary.

Write the summary under these headings, each as short as the facts allow:
- Goal: what the person asked for, in their words where it matters.
- Done: the changes made, by file and function, and the commands run with their results.
- Findings: the facts established (versions, paths, behaviours, failing tests) that later steps depend on.
- Open: what is not finished, decisions still pending, and the person's standing instructions.

Rules:
- Tool results were cut to their head and may be incomplete: do not invent values, counts, paths or outputs that are not in the text. Name the file or command to re-read instead ("re-run the tests to see the failing names").
- Keep exact identifiers verbatim: file paths, function names, error messages, commit hashes, task keys.
- Write only the summary. No preamble, no closing remark, no advice to the reader.`

export function capabilityExtensions(): ExtensionModule[] {
  return [
    {
      name: "compaction",
      title: "Compaction",
      description: "Summarize earlier conversation history when the model context needs room.",
      workload: "text_generation",
    },
    {
      name: "images",
      title: "Images",
      description: "Generate images with the configured image model and attach reference images.",
      workload: "image_generation",
    },
    { name: "schedules", title: "Schedules", description: "Schedule agent tasks and manage recurring work." },
  ].map(
    (capability): ExtensionModule => ({
      descriptor: {
        id: "nexus." + capability.name,
        name: capability.title,
        description: capability.description,
        default_enabled: true,
        configuration_version: 1,
        configuration_schema: {
          type: "object",
          properties: capability.workload
            ? {
                model: {
                  type: ["string", "null"],
                  "x-nexus-choices": { source: "models", workload: capability.workload },
                },
              }
            : {},
          additionalProperties: false,
        },
        defaults: capability.workload ? { model: null } : {},
      },
      register() {},
    }),
  )
}

export function capabilityConfiguration(extensions: Nexus.Extension[], kernel: string[]) {
  const compaction = extensions.find((extension) => extension.id === "nexus.compaction" && extension.active)
  const images = extensions.find((extension) => extension.id === "nexus.images" && extension.active)
  const schedules = extensions.some((extension) => extension.id === "nexus.schedules" && extension.active)
  const hidden = new Set([
    ...(!images ? Toolsets.names("images") : []),
    ...(!schedules ? Toolsets.names("schedules") : []),
  ])
  return {
    kernel_tools: kernel.filter((name) => !hidden.has(name)),
    compaction_policy: compaction
      ? {
          mode: "kernel",
          ...(typeof compaction.configuration.model === "string" ? { model: compaction.configuration.model } : {}),
        }
      : { mode: "off" },
    image_model: images && typeof images.configuration.model === "string" ? images.configuration.model : null,
  }
}
