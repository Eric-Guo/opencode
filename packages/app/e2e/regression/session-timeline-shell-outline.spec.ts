import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, shell, userMessage } from "../performance/timeline-stability/fixture"

for (const deviceScaleFactor of [1.25, 1.5]) {
  test(`keeps the shell outline inside a fractionally short virtual row at ${deviceScaleFactor}x`, async ({ page }) => {
    const shellID = "prt_shell_outline"
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([shell(shellID, "completed", "shell output")])],
      settings: { newLayoutDesigns: true, shellToolPartsExpanded: true },
      reducedMotion: true,
      deviceScaleFactor,
    })
    const part = page.locator(`[data-timeline-part-id="${shellID}"]`)
    const output = part.locator('[data-component="bash-output"]')
    const row = page.locator("[data-timeline-key]", { has: part })
    await expect(output).toBeVisible()
    await timeline.settle()

    const geometry = await row.evaluate((element) => {
      const output = element.querySelector<HTMLElement>('[data-component="bash-output"]')
      if (!output) throw new Error("Shell output is unavailable")
      const rowRect = element.getBoundingClientRect()
      const outputRect = output.getBoundingClientRect()
      // Match a rounded-down measurement at a fractional device-pixel phase.
      element.style.height = `${outputRect.bottom - rowRect.top - 0.49}px`
      element.style.transform = "translateY(0.25px)"
      output.style.setProperty("--v2-border-border-base", "rgb(255, 0, 255)")
      output.style.setProperty("background", "rgb(0, 0, 0)", "important")
      const style = getComputedStyle(output)
      return {
        outputWidth: outputRect.width,
        outputHeight: outputRect.height,
        borderColor: style.borderTopColor,
        boxShadow: style.boxShadow,
        clipMargin: getComputedStyle(element).overflowClipMargin,
      }
    })
    await timeline.settle()

    const clipped = await row.evaluate((element) => {
      const output = element.querySelector<HTMLElement>('[data-component="bash-output"]')!
      return output.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
    })
    expect(clipped).toBeCloseTo(0.49, 1)

    const box = await output.boundingBox()
    if (!box) throw new Error("Shell output bounds are unavailable")
    expect(await page.evaluate(() => devicePixelRatio)).toBe(deviceScaleFactor)
    const screenshot = await page.screenshot()
    const edges = await page.evaluate(
      async ({ source, size, viewport }) => {
        const image = new Image()
        image.src = source
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext("2d")
        if (!context) throw new Error("2D canvas is unavailable")
        context.drawImage(image, 0, 0)
        const scale = {
          x: image.naturalWidth / viewport.width,
          y: image.naturalHeight / viewport.height,
        }
        const pixels = context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data
        const rows = new Uint32Array(image.naturalHeight)
        const columns = new Uint32Array(image.naturalWidth)
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! <= 200 || pixels[index + 1]! >= 50 || pixels[index + 2]! <= 200) continue
          const pixel = index / 4
          const x = pixel % image.naturalWidth
          const y = Math.floor(pixel / image.naturalWidth)
          rows[y] = rows[y]! + 1
          columns[x] = columns[x]! + 1
        }
        return {
          horizontal: Array.from(rows).filter((count) => count > size.width * scale.x * 0.75).length,
          vertical: Array.from(columns).filter((count) => count > size.height * scale.y * 0.75).length,
        }
      },
      {
        source: `data:image/png;base64,${screenshot.toString("base64")}`,
        viewport: page.viewportSize()!,
        size: { width: box.width, height: box.height },
      },
    )

    expect(box.width).toBeCloseTo(geometry.outputWidth, 2)
    expect(box.height).toBeCloseTo(geometry.outputHeight, 2)
    expect(geometry.borderColor).toBe("rgb(255, 0, 255)")
    expect(geometry.boxShadow).toBe("none")
    expect(geometry.clipMargin).toBe("0.5px")
    expect(edges.horizontal).toBeGreaterThanOrEqual(2)
    expect(edges.vertical).toBeGreaterThanOrEqual(2)
  })
}
