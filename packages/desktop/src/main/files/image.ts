import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app, dialog } from "electron"
import type { ContextMenuParams, WebContents } from "electron"
import { Schema } from "effect"
import { nativeT } from "../native/translations"
import { getWindowFromWebContents } from "../windows/content"

const extensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/svg+xml", "svg"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
])

export function saveImageAs(
  contents: WebContents,
  url: string,
  context?: Pick<ContextMenuParams, "x" | "y" | "frame">,
): Promise<void> {
  const owner = getWindowFromWebContents(contents)

  return (
    imageSource(contents, url, context)
      .then(async (source) => {
        if (!source.startsWith("data:")) {
          contents.downloadURL(source)

          return
        }

        // Node fetch decodes inline images without routing their large URLs through Chromium IPC.
        const response = await fetch(source)
        const extension = extensions.get(response.headers.get("content-type")?.split(";")[0] ?? "")
        const bytes = Buffer.from(await response.arrayBuffer())

        const options = {
          title: nativeT("desktop.dialog.saveFile"),
          defaultPath: join(app.getPath("downloads"), extension ? `image.${extension}` : "image"),
        }

        const result = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options))

        if (result.canceled || !result.filePath) return

        await writeFile(result.filePath, bytes)
      })
      // SAFETY: Node fetch and filesystem failures enter this boundary as unknown errors.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      .catch(async (error: unknown) => {
        const options = {
          type: "error" as const,
          message: nativeT("desktop.dialog.saveImageFailed"),
          detail: error instanceof Error ? error.message : String(error),
        }

        await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
      })
  )
}

async function imageSource(contents: WebContents, url: string, context?: Pick<ContextMenuParams, "x" | "y" | "frame">) {
  if (url) return url

  if (!context?.frame) throw new Error(nativeT("desktop.dialog.imageUnavailable"))

  // Chromium clears context-menu srcURL above its 2 MiB URL limit, even for a loaded image.
  // Read the original element in its renderer instead of downloading the empty URL.
  const zoom = contents.getZoomFactor()

  const source = await context.frame.executeJavaScript(`(() => {
    const image = document.elementFromPoint(${context.x / zoom}, ${context.y / zoom})
    return image instanceof HTMLImageElement ? image.currentSrc || image.src : ""
  })()`)

  if (!Schema.is(Schema.String)(source) || !source.startsWith("data:image/"))
    throw new Error(nativeT("desktop.dialog.imageUnavailable"))

  return source
}
