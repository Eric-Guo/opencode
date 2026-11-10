import { expect, test } from "bun:test"
import { ImageDimensions } from "@opencode/core/image/dimensions"

test.each(["png", "jpg", "gif", "webp", "lossless.webp", "alpha.webp"])("reads %s canvas dimensions", async (format) => {
  const file = format.includes(".") ? `canvas-${format}` : `canvas.${format}`
  const bytes = await Bun.file(new URL(`./fixture/image-dimensions/${file}`, import.meta.url)).bytes()
  expect(ImageDimensions.read(bytes)).toEqual({ width: 5, height: 3 })
  // Also exercise byteOffset: server reads may be slices of a larger buffer.
  expect(ImageDimensions.read(Buffer.concat([Buffer.from("prefix"), bytes]).subarray(6))).toEqual({ width: 5, height: 3 })
  expect(ImageDimensions.read(bytes.subarray(0, 9))).toBeUndefined()
})

test("does not invent dimensions for unknown or malformed images", () => {
  expect(ImageDimensions.read(new Uint8Array())).toBeUndefined()
  expect(ImageDimensions.read(Buffer.from("not an image"))).toBeUndefined()
  expect(ImageDimensions.read(Buffer.from("ffd8ffe00000", "hex"))).toBeUndefined()
  expect(ImageDimensions.read(Buffer.from("ffd8ffe0ffff", "hex"))).toBeUndefined()
})
