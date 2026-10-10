import type { BundledFontProvider } from "@betteroffice/docx/layout"
import {
  createFontProvider,
  loadBundledFontBytes,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
  type BundledFontFace,
  type BundledFontScript,
} from "@betteroffice/fonts"

/** Office fonts, including CJK faces, load from the app's own assets only when a document needs them. */
export function wordFonts(): BundledFontProvider {
  return createFontProvider()
}

/** The face PowerPoint draws a family with: its metric-compatible or bundled face, else PowerPoint's substitute. */
export function presentationFace(family: string, bold: boolean, italic: boolean): BundledFontFace {
  return (
    resolveMetricCompatFace(family, bold, italic) ??
    resolveBundledFamilyFace(family, bold, italic) ??
    resolveLastResortFace(family, bold, italic, "powerpoint")
  )
}

/** The face that covers a script the Latin faces lack, or undefined when the app ships none. */
export function scriptFace(script: BundledFontScript, bold: boolean, italic: boolean) {
  return resolveScriptFallbackFace(script, bold, italic)
}

/**
 * A bundled face's bytes. The font package caches them per worker, so a face loads once per open file; the browser's
 * caches, which every worker shares, serve the files to the next.
 */
export function loadFace(face: BundledFontFace) {
  return loadBundledFontBytes(face)
}
