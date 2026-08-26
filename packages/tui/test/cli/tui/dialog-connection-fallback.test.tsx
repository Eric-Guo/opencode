/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogConnectionFallback } from "../../../src/component/dialog-connection-fallback"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("confirms a blank session only after selecting the recovery action", async () => {
  let confirmed = 0
  const app = await render(() => confirmed++)

  try {
    await app.waitForFrame(
      (frame) =>
        frame.includes("Kimi account switched") &&
        frame.includes("KIMI_API_KEY_2 is now selected") &&
        frame.includes("new session"),
    )
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => !frame.includes("Kimi account switched"))
    expect(confirmed).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the failed session when recovery is cancelled", async () => {
  let confirmed = 0
  const app = await render(() => confirmed++)

  try {
    await app.waitForFrame((frame) => frame.includes("Kimi account switched"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => !frame.includes("Kimi account switched"))
    expect(confirmed).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

async function render(onConfirm: () => void) {
  function Fixture() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogConnectionFallback
          previous="KIMI_API_KEY"
          promoted="KIMI_API_KEY_2"
          unavailableUntil={18_000_000}
          onConfirm={onConfirm}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  return app
}
