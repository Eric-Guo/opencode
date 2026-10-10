import { describe, expect, test } from "bun:test"
import { loadFace, presentationFace, scriptFace, wordFonts } from "./fonts"

// East Asian family names, aliases and weight variants must keep CJK glyph coverage.
const eastAsian = [
  "Microsoft YaHei",
  "DengXian",
  "等线",
  "等线 Light",
  "Microsoft YaHei Light",
  "Yu Gothic Medium",
  "Malgun Gothic Semilight",
  "MS Mincho",
]

describe("presentationFace", () => {
  test("draws East Asian families with a face the app ships", async () => {
    const faces = eastAsian.map((family) => presentationFace(family, false, false))

    expect(faces.map((face) => face.script)).toEqual([
      "cjk-sc",
      "cjk-sc",
      "cjk-sc",
      "cjk-sc",
      "cjk-sc",
      "cjk-jp",
      "cjk-kr",
      "cjk-jp",
    ])

    const bytes = await Promise.all(faces.map(loadFace))

    expect(bytes.every((buffer) => buffer.byteLength > 0)).toBe(true)
  })

  test("keeps East Asian weight variants on CJK faces", () => {
    expect(presentationFace("Yu Mincho Light", false, false).script).toBe("cjk-jp")
    expect(presentationFace("Yu Gothic Light", false, false).script).toBe("cjk-jp")
    expect(presentationFace("宋体", false, false).family).toBe("Noto Serif SC")
  })

  test("still resolves Latin families to their metric-compatible faces", () => {
    expect(presentationFace("Calibri", true, false)).toMatchObject({ family: "Carlito", weight: 700 })
    expect(presentationFace("Calibri Light", false, false).family).toBe("Carlito")
    expect(presentationFace("Arial", false, true)).toMatchObject({ family: "Liberation Sans", style: "italic" })
  })
})

describe("wordFonts", () => {
  test("loads Chinese family aliases and script fallbacks instead of Latin-only substitutes", async () => {
    const fonts = wordFonts()
    const chinese = ["Microsoft YaHei", "DengXian", "等线", "宋体"]
    const bytes = await Promise.all(chinese.map((family) => fonts.resolve(family, false, false)?.()))

    expect(bytes.every((buffer) => buffer && buffer.byteLength > 0)).toBe(true)
    expect(await fonts.resolveScriptFallback?.("cjk-sc", false, false)?.()).toEqual(bytes[0])
  })

  test.each(["cjk-sc", "cjk-tc", "cjk-jp", "cjk-kr"] as const)(
    "loads the %s fallback even for bold italic text",
    async (script) => {
      const face = scriptFace(script, true, true)

      expect(face?.script).toBe(script)
      expect(await wordFonts().resolveScriptFallback?.(script, true, true)?.()).toBeInstanceOf(ArrayBuffer)
    },
  )

  test("loads a last-resort face for every East Asian weight variant", async () => {
    const fonts = wordFonts()

    const bytes = await Promise.all(
      eastAsian.map((family) => fonts.resolveLastResort?.(family, false, false, "word")?.()),
    )

    expect(bytes.map((buffer) => (buffer?.byteLength ?? 0) > 0)).toEqual(eastAsian.map(() => true))
  })

  test("still loads metric-compatible faces for Latin families", async () => {
    const bytes = await wordFonts().resolve("Times New Roman", false, false)?.()

    expect(bytes?.byteLength).toBeGreaterThan(0)
  })
})
