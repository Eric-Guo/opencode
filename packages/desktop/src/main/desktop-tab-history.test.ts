import { describe, expect, test } from "bun:test"
import { recentDesktopTabHistory } from "./desktop-tab-history"

describe("desktop tab history", () => {
  test("returns the latest ten URLs with navigation indexes", () => {
    const history = recentDesktopTabHistory(
      Array.from({ length: 12 }, (_, index) => ({ url: `https://example.com/${index}` })),
      7,
    )

    expect(history).toHaveLength(10)
    expect(history.map((entry) => entry.index)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
    expect(history.find((entry) => entry.active)).toEqual({
      index: 7,
      url: "https://example.com/7",
      active: true,
    })
  })
})
