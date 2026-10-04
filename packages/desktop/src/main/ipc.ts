export * as Ipc from "./ipc"

import { ipcMain, MessageChannelMain } from "electron"
import type { WebContents } from "electron"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { DesktopRpcs } from "../shared/ipc-rpc"
import { DragCancelEvent, IpcTransportPort } from "../shared/ipc-transport"
import { Extensions } from "./extension/index"
import { DesktopFiles, openExternalURL } from "./files"
import { appHandlers } from "./ipc-handlers/app"
import { eventHandlers } from "./ipc-handlers/events"
import { extensionHandlers } from "./ipc-handlers/extensions"
import { fileHandlers } from "./ipc-handlers/files"
import { menuHandlers } from "./ipc-handlers/menu"
import { storageHandlers } from "./ipc-handlers/storage"
import { windowHandlers } from "./ipc-handlers/window"
import { IpcPortHandoff, IpcServerProtocolLive } from "./ipc-transport"
import { ApplicationLifecycle } from "./lifecycle"
import { showCliInstaller } from "./native/install-cli"
import { createMenu, sendMenuCommand } from "./native/menu"
import { DesktopCli } from "./service/desktop-cli"
import { BackgroundService } from "./service/background-service"
import extension from "#desktop-main-extension"
import {
  getNavigationHistory,
  getLastFocusedWindow,
  goToNavigationHistory,
  subscribeNavigationHistory,
  subscribeWebContents,
} from "./windows"

const services = Layer.mergeAll(DesktopFiles.layer, Extensions.layer)

const handlers = Layer.mergeAll(
  appHandlers,
  storageHandlers,
  fileHandlers,
  windowHandlers,
  menuHandlers,
  eventHandlers,
  extensionHandlers,
)

export const layer = RpcServer.layer(DesktopRpcs, { disableFatalDefects: true }).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(IpcServerProtocolLive),
  Layer.provideMerge(services),
)

export const registerIpcHandlers = Effect.gen(function* () {
  const handoff = yield* IpcPortHandoff
  const lifecycle = yield* ApplicationLifecycle.Service
  const desktopCli = yield* DesktopCli.Service
  const background = yield* BackgroundService.Service
  const context = yield* Effect.context()
  const runFork = Effect.runForkWith(context)
  const runPromise = Effect.runPromiseWith(context)

  const menu = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()

      if (win) sendMenuCommand(win, id)
    },
    installCli: () => runFork(showCliInstaller(desktopCli)),
    createWindow: lifecycle.createWindow,
    openExternal: (url: string) => runFork(openExternalURL(url)),
    relaunch: lifecycle.relaunch,
    getHistory: () => getNavigationHistory(getLastFocusedWindow()),
    goToHistory: (index: number) => goToNavigationHistory(getLastFocusedWindow(), index),
    onHistoryChange: subscribeNavigationHistory,
  }

  const wire = (contents: WebContents) => {
    contents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return
      contents.send(DragCancelEvent)
    })

    const post = () => {
      if (contents.isDestroyed()) return
      const channel = new MessageChannelMain()
      handoff.bind(contents, channel.port1)
      contents.postMessage(IpcTransportPort, null, [channel.port2])
    }

    contents.on("did-finish-load", post)
    // The first window starts loading before the layers exist and may already be done.

    if (!contents.isLoading() && contents.getURL()) post()
  }

  const unsubscribe = subscribeWebContents(wire)
  const handlers = extension.ipc?.({ connection: () => runPromise(background.connection) }) ?? {}
  Object.entries(handlers).forEach(([channel, handle]) => ipcMain.handle(channel, handle))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribe()
      Object.keys(handlers).forEach((channel) => ipcMain.removeHandler(channel))
    }),
  )

  return {
    installMenu: () => createMenu(menu),
  }
})
