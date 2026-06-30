import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"

type DesktopTabBase = {
  id: string
  title: string
  label: string
  releaseWhenLostFocus?: boolean
  systemControlColor?: string
}

type OpenCodeDesktopTab = DesktopTabBase & {
  id: "opencode"
}

export type RendererDesktopTab = DesktopTabBase & {
  html: string
  devHtml?: string
}

export type ExternalDesktopTab = DesktopTabBase & {
  url: string
  partition: string
}

type DesktopTab = OpenCodeDesktopTab | RendererDesktopTab | ExternalDesktopTab

export function loadDesktopTabs() {
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (!configDir) throw new Error("OPENCODE_CONFIG_DIR is required to load desktop tabs")

  const source = join(configDir, "sigmaagents.jsonc")
  const errors: ParseError[] = []
  const config = parse(readFileSync(source, "utf8"), errors, { allowTrailingComma: true }) as unknown
  if (errors.length) throw new Error(`Invalid desktop tab config: ${source}`)
  if (!isRecord(config) || !Array.isArray(config.desktopTabs)) {
    throw new Error(`Desktop tab config must contain a desktopTabs array: ${source}`)
  }

  const tabs = config.desktopTabs.map((tab, index) => parseDesktopTab(tab, index, source))
  if (!tabs.some((tab) => tab.id === "opencode")) {
    throw new Error(`Desktop tab config must contain the opencode tab: ${source}`)
  }
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    throw new Error(`Desktop tab config contains duplicate IDs: ${source}`)
  }
  return tabs
}

function parseDesktopTab(value: unknown, index: number, source: string): DesktopTab {
  if (!isRecord(value)) throw invalidTab(index, source)
  if (!isString(value.id) || !isString(value.title) || !isString(value.label)) throw invalidTab(index, source)
  if (value.releaseWhenLostFocus !== undefined && typeof value.releaseWhenLostFocus !== "boolean") {
    throw invalidTab(index, source)
  }
  if (value.systemControlColor !== undefined && !isString(value.systemControlColor)) throw invalidTab(index, source)

  const base = {
    id: value.id,
    title: value.title,
    label: value.label,
    ...(value.releaseWhenLostFocus === undefined ? {} : { releaseWhenLostFocus: value.releaseWhenLostFocus }),
    ...(value.systemControlColor === undefined ? {} : { systemControlColor: value.systemControlColor }),
  }
  if (isString(value.url) && isString(value.partition) && URL.canParse(value.url)) {
    return { ...base, url: value.url, partition: value.partition }
  }
  if (isString(value.html) && (value.devHtml === undefined || isString(value.devHtml))) {
    return { ...base, html: value.html, ...(value.devHtml === undefined ? {} : { devHtml: value.devHtml }) }
  }
  if (value.id === "opencode") return { ...base, id: "opencode" }
  throw invalidTab(index, source)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function invalidTab(index: number, source: string) {
  return new Error(`Invalid desktop tab at desktopTabs[${index}]: ${source}`)
}
