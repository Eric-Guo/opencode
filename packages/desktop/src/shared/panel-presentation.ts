import { Schema } from "effect"

export const panelVariables = [
  "--background-base",
  "--background-weak",
  "--background-strong",
  "--text-base",
  "--text-weak",
  "--text-strong",
  "--border-base",
  "--icon-base",
  "--icon-weak",
  "--v2-icon-icon-muted",
  "--surface-base",
  "--surface-raised-base",
  "--font-family-sans",
  "--font-family-mono",
  "--line-height-base",
  "--line-height-compact",
  "--font-weight-medium",
] as const

export const PanelPresentation = Schema.Struct({
  mode: Schema.Literals(["light", "dark"]),
  locale: Schema.String,
  motion: Schema.optional(Schema.Literals(["reduce", "full"])),
  direction: Schema.Literals(["ltr", "rtl"]),
  variables: Schema.Record(Schema.String, Schema.String),
  stylesheets: Schema.Array(Schema.String),
})
