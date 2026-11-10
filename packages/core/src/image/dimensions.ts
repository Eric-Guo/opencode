export * as ImageDimensions from "./dimensions.js"

import { Mime } from "../mime.js"

/** Read the encoded canvas size without decoding or resizing the image. */
export function read(bytes: Uint8Array) {
  const size = header(bytes)
  return size && size.width > 0 && size.height > 0 ? size : undefined
}

function header(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const mime = Mime.detect(bytes)

  if (mime === "image/png" && bytes.length >= 24 && view.getUint32(12) === 0x49484452)
    return { width: view.getUint32(16), height: view.getUint32(20) }

  if (mime === "image/gif" && bytes.length >= 10)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }

  if (mime === "image/webp" && bytes.length >= 25) {
    const chunk = view.getUint32(12)
    if (chunk === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (bytes.length < 30) return
    if (chunk === 0x56503858)
      return { width: (view.getUint32(23, true) >>> 8) + 1, height: (view.getUint32(26, true) >>> 8) + 1 }
    if (chunk === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    return
  }

  if (mime !== "image/jpeg") return
  for (let offset = 2; offset + 3 < bytes.length; ) {
    if (bytes[offset] !== 0xff) return
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker === 0xda || marker === 0xd9) return
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = view.getUint16(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8)
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    offset += 2 + length
  }
}
