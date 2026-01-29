import { fix, LOCALE_HEADER } from "@opencode/locale"

export const LOCALES = ["en", "zh"] as const

export type Locale = (typeof LOCALES)[number]

export {
  LOCALE_COOKIE,
  clearCookie,
  cookie,
  dir,
  label,
  tag,
} from "@opencode/locale"

export { LOCALE_HEADER }

const DOCS = {
  en: "root",
  zh: "zh-cn",
} satisfies Record<Locale, string>

const DOCS_SEGMENT = new Set(["zh-cn"])

const DOCS_LOCALE = {
  en: "en",
  "zh-cn": "zh",
} as const satisfies Record<string, Locale>

function suffix(pathname: string) {
  const index = pathname.search(/[?#]/)
  if (index === -1) {
    return {
      path: fix(pathname),
      suffix: "",
    }
  }

  return {
    path: fix(pathname.slice(0, index)),
    suffix: pathname.slice(index),
  }
}

function docs(locale: Locale, pathname: string) {
  const value = DOCS[locale]
  const next = suffix(pathname)
  if (next.path !== "/docs" && next.path !== "/docs/" && !next.path.startsWith("/docs/")) {
    return `${next.path}${next.suffix}`
  }

  if (value === "root") {
    if (next.path === "/docs/en") return `/docs${next.suffix}`
    if (next.path === "/docs/en/") return `/docs/${next.suffix}`
    if (next.path.startsWith("/docs/en/")) return `/docs/${next.path.slice("/docs/en/".length)}${next.suffix}`
    return `${next.path}${next.suffix}`
  }

  if (next.path === "/docs") return `/docs/${value}${next.suffix}`
  if (next.path === "/docs/") return `/docs/${value}/${next.suffix}`

  const head = next.path.slice("/docs/".length).split("/")[0] ?? ""
  if (!head) return `/docs/${value}/${next.suffix}`
  if (DOCS_SEGMENT.has(head)) return `${next.path}${next.suffix}`
  if (head.startsWith("_")) return `${next.path}${next.suffix}`
  if (head.includes(".")) return `${next.path}${next.suffix}`

  return `/docs/${value}${next.path.slice("/docs".length)}${next.suffix}`
}

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null
  if (value === "en" || value === "zh") return value
  return null
}

export function fromPathname(pathname: string) {
  return parseLocale(fix(pathname).split("/")[1])
}

function fromDocsPathname(pathname: string) {
  const next = fix(pathname)
  const value = next.split("/")[2]?.toLowerCase()
  if (!value) return null
  if (!next.startsWith("/docs/")) return null
  if (!(value in DOCS_LOCALE)) return null
  return DOCS_LOCALE[value as keyof typeof DOCS_LOCALE]
}

export function strip(pathname: string) {
  const locale = fromPathname(pathname)
  if (!locale) return fix(pathname)

  const next = fix(pathname).slice(locale.length + 1)
  if (!next) return "/"
  if (next.startsWith("/")) return next
  return `/${next}`
}

export function route(locale: Locale, pathname: string) {
  const next = strip(pathname)
  if (next.startsWith("/docs")) return docs(locale, next)
  if (next.startsWith("/auth")) return next
  if (next.startsWith("/workspace")) return next
  // The changelog worker owns /changelog and only publishes English release notes.
  if (next === "/changelog" || next.startsWith("/changelog/")) return next
  if (locale === "en") return next
  if (next === "/") return `/${locale}`
  return `/${locale}${next}`
}

export function localeFromRequest(request: Request) {
  const fromHeader = parseLocale(request.headers.get(LOCALE_HEADER))
  if (fromHeader) return fromHeader

  const fromPath = fromPathname(new URL(request.url).pathname)
  if (fromPath) return fromPath

  const fromDocsPath = fromDocsPathname(new URL(request.url).pathname)
  if (fromDocsPath) return fromDocsPath

  // Unprefixed pages are English, like the rest of the site.
  return "en" satisfies Locale
}
