import z from "zod"
import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { BindingSectionsConfig, BindingValue } from "@opentui/keymap/extras"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigKeybinds } from "@/config/keybinds"

const KeybindOverride = z
  .object(
    Object.fromEntries(Object.keys(ConfigKeybinds.Keybinds.shape).map((key) => [key, z.string().optional()])) as Record<
      string,
      z.ZodOptional<z.ZodString>
    >,
  )
  .strict()

export const KeymapSectionNames = [
  "app",
  "session",
  "prompt",
  "prompt_clear",
  "prompt_paste",
  "prompt_history_previous",
  "prompt_history_next",
  "prompt_autocomplete",
  "input",
  "dialog_select",
  "dialog_stash",
  "dialog_session_list",
  "dialog_model",
  "dialog_mcp",
  "permission_reject",
  "permission_prompt_escape",
  "permission_prompt_fullscreen",
  "question",
  "question_edit",
  "plugins",
  "dialog_plugins",
  "home_tips",
] as const

export type KeymapSection = (typeof KeymapSectionNames)[number]
export type KeymapSections = Record<KeymapSection, Binding<Renderable, KeyEvent>[]>
export const KeymapLeaderTimeoutDefault = 2000
export type KeymapInfo = {
  leader: string
  leader_timeout: number
  sections: KeymapSections
}

const KeyStroke = z
  .object({
    name: z.string(),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    meta: z.boolean().optional(),
    super: z.boolean().optional(),
    hyper: z.boolean().optional(),
  })
  .strict()

const KeymapBindingObject = z
  .object({
    key: z.union([z.string(), KeyStroke]),
    event: z.enum(["press", "release"]).optional(),
    preventDefault: z.boolean().optional(),
    fallthrough: z.boolean().optional(),
  })
  .passthrough()

const KeymapBindingItem = z.union([z.string(), KeyStroke, KeymapBindingObject])
const KeymapBindingValue = z.union([z.literal(false), z.literal("none"), KeymapBindingItem, z.array(KeymapBindingItem)])
const KeymapSectionsConfig = z.record(z.string(), z.record(z.string(), KeymapBindingValue))

export const KeymapConfig = z
  .object({
    leader: z.string().optional(),
    leader_timeout: z.number().int().positive().optional().describe("Leader key timeout in milliseconds"),
    sections: KeymapSectionsConfig.optional(),
  })
  .strict()
  .describe("TUI keymap configuration")
export type KeymapConfig = z.output<typeof KeymapConfig>

export const TuiOptions = z.object({
  scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
  scroll_acceleration: z
    .object({
      enabled: z.boolean().describe("Enable scroll acceleration"),
    })
    .optional()
    .describe("Scroll acceleration settings"),
  diff_style: z
    .enum(["auto", "stacked"])
    .optional()
    .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
  mouse: z.boolean().optional().describe("Enable or disable mouse capture (default: true)"),
})

export const TuiInfo = z
  .object({
    $schema: z.string().optional(),
    theme: z.string().optional(),
    keybinds: KeybindOverride.optional().meta({
      deprecated: true,
      description: "Use keymap instead. This will be removed in opencode v2.0.",
    }),
    keymap: KeymapConfig.optional(),
    plugin: ConfigPlugin.Spec.zod.array().optional(),
    plugin_enabled: z.record(z.string(), z.boolean()).optional(),
  })
  .extend(TuiOptions.shape)
  .strict()
