import { expect, test } from "bun:test"
import { onDemandAsset } from "./vite.pwa"

test("keeps bundled CJK fonts available in the offline PWA precache", () => {
  for (const family of ["NotoSansSC", "NotoSerifSC", "NotoSansTC", "NotoSansJP", "NotoSansKR"]) {
    expect(onDemandAsset(`_assets/${family}-Regular-D7N4HOOt.otf`)).toBe(false)
  }

  expect(onDemandAsset("_assets/Carlito-Regular-D7N4HOOt.ttf")).toBe(true)
  expect(onDemandAsset("_assets/docx_edit_bg-D7N4HOOt.wasm")).toBe(true)
  expect(onDemandAsset("assets/Inter.ttf")).toBe(false)
  expect(onDemandAsset("_assets/app-D7N4HOOt.js")).toBe(false)
})
