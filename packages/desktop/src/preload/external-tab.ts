import { contextBridge, ipcRenderer } from "electron"
import type { CybrosCurrentUser, ServerReadyData } from "../shared/ipc-contract"

const api: {
  awaitInitialization: () => Promise<ServerReadyData>
  getCybrosCurrentUser: () => Promise<CybrosCurrentUser>
} = {
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  getCybrosCurrentUser: () => ipcRenderer.invoke("get-cybros-current-user"),
}

contextBridge.exposeInMainWorld("api", api)
