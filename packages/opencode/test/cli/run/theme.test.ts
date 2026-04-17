import { describe, expect, test } from "bun:test"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { opaqueSyntaxStyle } from "../../../src/cli/cmd/run/theme"

describe("run theme", () => {
  test("flattens subtle syntax alpha against the run background", () => {
    const syntax = SyntaxStyle.fromStyles({
      default: {
        fg: RGBA.fromInts(169, 177, 214, 153),
      },
      emphasis: {
        fg: RGBA.fromInts(224, 175, 104, 153),
        italic: true,
        bold: true,
      },
    })
    const subtle = opaqueSyntaxStyle(syntax, RGBA.fromInts(42, 43, 61))

    try {
      expect(subtle?.getStyle("default")?.fg?.toInts()).toEqual([118, 123, 153, 255])
      expect(subtle?.getStyle("emphasis")?.fg?.toInts()).toEqual([151, 122, 87, 255])
      expect(subtle?.getStyle("emphasis")?.italic).toBe(true)
      expect(subtle?.getStyle("emphasis")?.bold).toBe(true)
    } finally {
      syntax.destroy()
      subtle?.destroy()
    }
  })
})
