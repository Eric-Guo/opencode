import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI } from "./types"

const api: Pick<ElectronAPI, "awaitInitialization"> = {
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
}

contextBridge.exposeInMainWorld("api", api)
