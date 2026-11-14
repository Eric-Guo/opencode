import type { BrowserWindow, WebContents } from "electron"
import type { DesktopPanelPresentation } from "../../extension"
import { PanelPresentation, panelVariables } from "../../shared/panel-presentation"
import { getPrimaryWebContents } from "./content"

const presentations = new WeakMap<BrowserWindow, ReturnType<typeof createPresentation>>()

export function presentationFor(win: BrowserWindow) {
  const existing = presentations.get(win)

  if (existing) return existing
  const presentation = createPresentation()
  presentations.set(win, presentation)
  win.once("closed", presentation.dispose)

  return presentation
}

type Current = { value: DesktopPanelPresentation | undefined }

function createPresentation() {
  const current: Current = { value: undefined }
  const listeners = new Set<(value: DesktopPanelPresentation) => void>()

  return {
    get: () => current.value,
    subscribe(listener: (value: DesktopPanelPresentation) => void) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    set(value: DesktopPanelPresentation) {
      current.value = value
      listeners.forEach((listener) => listener(value))
    },
    dispose: () => listeners.clear(),
  }
}

export function setPanelPresentation(win: BrowserWindow, sender: WebContents, value: typeof PanelPresentation.Type) {
  if (sender !== getPrimaryWebContents(win)) throw new Error("Invalid panel presentation sender")
  const source = new URL(sender.getURL())
  presentationFor(win).set({
    ...value,
    variables: Object.fromEntries(
      panelVariables.flatMap((key) => (value.variables[key] === undefined ? [] : [[key, value.variables[key]]])),
    ),
    stylesheets: value.stylesheets.filter((href) => {
      const url = URL.parse(href)

      return (
        url?.protocol === source.protocol &&
        url.host === source.host &&
        ["oc:", "http:", "https:"].includes(url.protocol)
      )
    }),
  })
}
