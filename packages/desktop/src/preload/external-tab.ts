import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI } from "./types"
import { Ipc } from "../shared/ipc-contract"

const api: Pick<ElectronAPI, "awaitInitialization" | "getCybrosCurrentUser"> = {
  awaitInitialization: () => ipcRenderer.invoke(Ipc.app.awaitInitialization),
  getCybrosCurrentUser: () => ipcRenderer.invoke(Ipc.app.getCybrosCurrentUser),
}

contextBridge.exposeInMainWorld("api", api)
