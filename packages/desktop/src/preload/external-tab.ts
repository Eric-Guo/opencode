import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI } from "./types"

const api: Pick<ElectronAPI, "awaitInitialization" | "getCybrosCurrentUser"> = {
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  getCybrosCurrentUser: () => ipcRenderer.invoke("get-cybros-current-user"),
}

contextBridge.exposeInMainWorld("api", api)
