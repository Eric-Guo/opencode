/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { FilePath } from "../../src/ui/file-path"

test("renders the parent and basename", async () => {
  const app = await testRender(() => <FilePath value="packages/tui/src/ui/file-path.tsx" maxWidth={24} />, {
    width: 30,
    height: 1,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("…/src/ui/file-path.tsx")
  } finally {
    app.renderer.destroy()
  }
})

test("updates the parent and basename", async () => {
  const [value, setValue] = createSignal("packages/tui/src/ui/file-path.tsx")
  const app = await testRender(() => <FilePath value={value()} maxWidth={24} />, { width: 30, height: 1 })

  try {
    await app.renderOnce()
    setValue("packages/tui/src/ui/fade-file-path.tsx")
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("…/ui/fade-file-path.tsx")
  } finally {
    app.renderer.destroy()
  }
})
