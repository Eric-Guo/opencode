import { describe, expect, test } from "bun:test"
import { translate } from "../src/i18n"
import { packCard, unpackCard } from "../src/share/embed"
import { retentionCard } from "../src/share/sections"

describe("plural forms", () => {
  test("a word agrees with its count in the locale's plural rules", () => {
    expect(translate("en", "share.range.pastDays", { count: 1 })).toBe("Past 1 day")
    expect(translate("en", "share.range.pastDays", { count: 55 })).toBe("Past 55 days")
    expect(translate("zh", "share.range.pastDays", { count: 55 })).toBe("过去 55 天")
  })
})

describe("share cards", () => {
  test("a card is written in the language it's made in", () => {
    const retention = [{ model: "glm-5", name: "GLM-5", rate: 61.2 }] as Parameters<typeof retentionCard>[1]
    const card = retentionCard("zh", retention)
    expect(card?.locale).toBe("zh")
    expect(card?.title).toBe("每周留存率")
    expect(card?.headline).toBe("GLM-5 在下一周留住了 61.2% 的 OpenCode 用户")
  })

  test("a fixed embed in a language it can't read is drawn in English", async () => {
    const card = retentionCard("zh", [{ model: "glm-5", name: "GLM-5", rate: 61.2 }] as Parameters<
      typeof retentionCard
    >[1])!
    const packed = await packCard({ ...card, locale: "xx" as "en", updatedAt: null, url: "opencode.ai/data" })
    expect((await unpackCard(packed)).locale).toBe("en")
  })
})
