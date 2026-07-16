import { contextBridge, ipcRenderer } from "electron"
import type { ElectronAPI, ServerReadyData } from "./types"

const localAgent = process.argv
  .find((argument) => argument.startsWith("--local-agent="))
  ?.slice("--local-agent=".length)

const api: Pick<ElectronAPI, "awaitInitialization"> = {
  awaitInitialization: () =>
    ipcRenderer.invoke("await-initialization").then((data: ServerReadyData) => ({
      ...data,
      ...(localAgent ? { localAgent } : {}),
    })),
}

contextBridge.exposeInMainWorld("api", api)
