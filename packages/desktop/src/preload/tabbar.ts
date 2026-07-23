import { contextBridge, ipcRenderer } from "electron"

type DesktopTabID = string
type DesktopTabAction = "settings" | "help" | "changelog"
type DesktopTabsState = {
  active: DesktopTabID
  tabs: {
    id: DesktopTabID
    title: string
    label: string
    skipDisplay: boolean
  }[]
}

const tabIDs = new Set<DesktopTabID>()
const actions = new Set<DesktopTabAction>(["settings", "help", "changelog"])

const api = {
  select: (id: DesktopTabID) => {
    if (!tabIDs.has(id)) return
    ipcRenderer.send("desktop-tabs-select", id)
  },
  action: (action: DesktopTabAction) => {
    if (!actions.has(action)) return
    ipcRenderer.send("desktop-tabs-action", action)
  },
  subscribe: (cb: (state: DesktopTabsState) => void) => {
    const handler = (_event: unknown, state: DesktopTabsState) => {
      state.tabs.forEach((tab) => tabIDs.add(tab.id))
      cb(state)
    }
    ipcRenderer.on("desktop-tabs-state", handler)
    ipcRenderer.send("desktop-tabs-subscribe")
    return () => {
      ipcRenderer.removeListener("desktop-tabs-state", handler)
      ipcRenderer.send("desktop-tabs-unsubscribe")
    }
  },
}

contextBridge.exposeInMainWorld("desktopTabs", api)
