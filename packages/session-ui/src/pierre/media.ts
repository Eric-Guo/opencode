import { Schema } from "effect"
import type { PresentationFileContent } from "../file-presentation"

export type MediaKind = "image" | "audio" | "svg"

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff", "heic"])

const audioExtensions = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"])

export type MediaValue = Schema.Json | PresentationFileContent | undefined

const textValue = Schema.is(Schema.String)

const isMediaRecord = Schema.is(
  Schema.Struct({
    content: Schema.optional(Schema.String),
    encoding: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
  }),
)

function mediaRecord(value: MediaValue) {
  return isMediaRecord(value) ? value : undefined
}

export function normalizeMimeType(type: string | undefined) {
  if (!type) return
  const mime = type.split(";", 1)[0]?.trim().toLowerCase()

  if (!mime) return

  if (mime === "audio/x-aac") return "audio/aac"

  if (mime === "audio/x-m4a") return "audio/mp4"

  return mime
}

export function fileExtension(path: string | undefined) {
  if (!path) return ""
  const idx = path.lastIndexOf(".")

  if (idx === -1) return ""

  return path.slice(idx + 1).toLowerCase()
}

export function mediaKindFromPath(path: string | undefined): MediaKind | undefined {
  const ext = fileExtension(path)

  if (ext === "svg") return "svg"

  if (imageExtensions.has(ext)) return "image"

  if (audioExtensions.has(ext)) return "audio"
}

export function isBinaryContent(value: MediaValue) {
  return mediaRecord(value)?.type === "binary"
}

function validDataUrl(value: string, kind: MediaKind) {
  if (kind === "svg") return value.startsWith("data:image/svg+xml") ? value : undefined

  if (kind === "image") return value.startsWith("data:image/") ? value : undefined

  if (value.startsWith("data:audio/x-aac;")) return value.replace("data:audio/x-aac;", "data:audio/aac;")

  if (value.startsWith("data:audio/x-m4a;")) return value.replace("data:audio/x-m4a;", "data:audio/mp4;")

  if (value.startsWith("data:audio/")) return value
}

export function dataUrlFromMediaValue(value: MediaValue, kind: MediaKind) {
  if (!value) return

  if (textValue(value)) {
    return validDataUrl(value, kind)
  }

  const record = mediaRecord(value)

  if (!record) return

  if (record.content === undefined) return

  const mime = normalizeMimeType(record.mimeType)

  if (!mime) return

  if (kind === "svg") {
    if (mime !== "image/svg+xml") return

    if (record.encoding === "base64") return `data:image/svg+xml;base64,${record.content}`

    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(record.content)}`
  }

  if (kind === "image" && !mime.startsWith("image/")) return

  if (kind === "audio" && !mime.startsWith("audio/")) return

  if (record.encoding !== "base64") return

  return `data:${mime};base64,${record.content}`
}

function decodeBase64Utf8(value: string) {
  if (typeof atob === "undefined") return

  try {
    const raw = atob(value)
    const bytes = Uint8Array.from(raw, (x) => x.charCodeAt(0))

    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes)

    return raw
  } catch {}
}

export function svgTextFromValue(value: MediaValue) {
  const record = mediaRecord(value)

  if (!record) return

  if (record.content === undefined) return

  const mime = normalizeMimeType(record.mimeType)

  if (mime !== "image/svg+xml") return

  if (record.encoding === "base64") return decodeBase64Utf8(record.content)

  return record.content
}

export function hasMediaValue(value: MediaValue) {
  if (textValue(value)) return value.length > 0
  const record = mediaRecord(value)

  if (!record) return false

  return !!record.content?.length
}
