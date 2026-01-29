import { describe, expect, test } from "bun:test"
import { LOCALE_HEADER, pageLocale, route } from "../src/lib/language"

describe("language.route", () => {
  test("keeps the changelog unprefixed for every locale", () => {
    expect(route("en", "/changelog")).toBe("/changelog")
    expect(route("zh", "/zh/changelog")).toBe("/changelog")
  })

  test("prefixes other marketing pages", () => {
    expect(route("zh", "/download")).toBe("/zh/download")
  })
})

describe("pageLocale", () => {
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://opencode.ai${path}`, { headers })
  const chinese = { "accept-language": "zh-CN,zh;q=0.9", cookie: "oc_locale=zh" }

  test("ignores the browser language and cookie on unprefixed pages", () => {
    expect(pageLocale(request("/", chinese))).toBe("en")
    expect(pageLocale(request("/docs/agents/", chinese))).toBe("en")
  })

  test("uses the locale in the URL", () => {
    expect(pageLocale(request("/", { [LOCALE_HEADER]: "zh" }))).toBe("zh")
    expect(pageLocale(request("/docs/zh-cn/agents/"))).toBe("zh")
  })
})
