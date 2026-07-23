import { contextBridge, ipcRenderer } from "electron"
import type { ServerReadyData } from "../shared/ipc-contract"

const api: { awaitInitialization: () => Promise<ServerReadyData> } = {
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
}

contextBridge.exposeInMainWorld("api", api)
