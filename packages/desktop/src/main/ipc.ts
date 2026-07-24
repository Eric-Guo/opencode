export * as Ipc from "./ipc"

import { ipcMain, MessageChannelMain, net } from "electron"
import type { WebContents } from "electron"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { DesktopRpcs } from "../shared/ipc-rpc"
import { IpcTransportPort } from "../shared/ipc-transport"
import { DesktopFiles, openExternalURL } from "./files"
import { appHandlers } from "./ipc-handlers/app"
import { eventHandlers } from "./ipc-handlers/events"
import { fileHandlers } from "./ipc-handlers/files"
import { menuHandlers } from "./ipc-handlers/menu"
import { storageHandlers } from "./ipc-handlers/storage"
import { updaterHandlers } from "./ipc-handlers/updater"
import { windowHandlers } from "./ipc-handlers/window"
import { wslHandlers } from "./ipc-handlers/wsl"
import { IpcPortHandoff, IpcServerProtocolLive } from "./ipc-transport"
import { ApplicationLifecycle } from "./lifecycle"
import { createMenu, sendMenuCommand } from "./native/menu"
import { BackgroundService } from "./service/background-service"
import { DesktopStorage } from "./storage"
import { Updater } from "./updater"
import {
  getDesktopTabHistory,
  getDesktopTabInitializationFromWebContents,
  getLastFocusedWindow,
  goToDesktopTabHistory,
  subscribeDesktopTabHistory,
  subscribeWebContents,
} from "./windows"
import { Wsl } from "./wsl/start"

const cybrosCurrentUserURL = "https://cybros.thape.com.cn/api/sigma_agents/me.json"
const services = Layer.mergeAll(DesktopFiles.layer, DesktopStorage.layer, Wsl.layer)
const handlers = Layer.mergeAll(
  appHandlers,
  storageHandlers,
  fileHandlers,
  windowHandlers,
  menuHandlers,
  updaterHandlers,
  wslHandlers,
  eventHandlers,
)
export const layer = RpcServer.layer(DesktopRpcs, { disableFatalDefects: true }).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(IpcServerProtocolLive),
  Layer.provideMerge(services),
)

export const registerIpcHandlers = Effect.gen(function* () {
  const handoff = yield* IpcPortHandoff
  const lifecycle = yield* ApplicationLifecycle.Service
  const background = yield* BackgroundService.Service
  const updater = yield* Updater.Service
  const context = yield* Effect.context()
  const runFork = Effect.runForkWith(context)
  const runPromise = Effect.runPromiseWith(context)
  const menu = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => runFork(updater.show),
    createWindow: lifecycle.createWindow,
    openExternal: (url: string) => runFork(openExternalURL(url)),
    relaunch: lifecycle.relaunch,
    getHistory: () => getDesktopTabHistory(getLastFocusedWindow()),
    goToHistory: (index: number) => goToDesktopTabHistory(getLastFocusedWindow(), index),
    onHistoryChange: subscribeDesktopTabHistory,
  }
  const wire = (contents: WebContents) => {
    contents.on("did-finish-load", () => {
      if (contents.isDestroyed()) return
      const channel = new MessageChannelMain()
      handoff.bind(contents, channel.port1)
      contents.postMessage(IpcTransportPort, null, [channel.port2])
    })
  }
  const unsubscribe = subscribeWebContents(wire)
  const awaitInitialization = (event: Electron.IpcMainInvokeEvent) =>
    runPromise(background.connection).then((data) => ({
      ...data,
      ...getDesktopTabInitializationFromWebContents(event.sender),
    }))
  const getCybrosCurrentUser = async () => {
    const key = process.env.THAPE_SSO_BEARER_API_KEY
    if (!key) throw new Error("Cybros SSO bearer key is not configured")
    const response = await net.fetch(cybrosCurrentUserURL, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
    })
    if (!response.ok) throw new Error(`Failed to load Cybros user: ${response.status}`)
    return response.json()
  }
  yield* Effect.sync(() => {
    ipcMain.handle("await-initialization", awaitInitialization)
    ipcMain.handle("get-cybros-current-user", getCybrosCurrentUser)
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribe()
      ipcMain.removeHandler("await-initialization")
      ipcMain.removeHandler("get-cybros-current-user")
    }),
  )
  return {
    installMenu: () => createMenu(menu),
  }
})
