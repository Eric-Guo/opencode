import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app, dialog } from "electron"
import type { WebContents } from "electron"
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

export function saveImageAs(contents: WebContents, url: string): Promise<void> {
  if (!url.startsWith("data:")) {
    contents.downloadURL(url)

    return Promise.resolve()
  }

  const owner = getWindowFromWebContents(contents)

  // Inline generated images must be written explicitly: Chromium's download dialog can close
  // without creating a file. Node fetch decodes both base64 and percent-encoded data URLs.
  return fetch(url)
    .then(async (response) => {
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
}
