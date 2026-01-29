import type { Locale } from "~/lib/language"
import { dict as en } from "~/i18n/en"
import { dict as zh } from "~/i18n/zh"

export type Key = keyof typeof en
export type Dict = Record<Key, string>

const base = en satisfies Dict

export function i18n(locale: Locale): Dict {
  if (locale === "en") return base
  if (locale === "zh") return { ...base, ...zh }
  return { ...base }
}
