export * as Ipc from "./ipc"

import { ipcMain, MessageChannelMain } from "electron"
import type { WebContents } from "electron"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { DesktopRpcs } from "../shared/ipc-rpc"
import { DragCancelEvent, IpcTransportPort } from "../shared/ipc-transport"
import { Plugins } from "./plugin"
import { DesktopFiles, openExternalURL } from "./files"
import { appHandlers } from "./ipc-handlers/app"
import { eventHandlers } from "./ipc-handlers/events"
import { pluginHandlers } from "./ipc-handlers/plugins"
import { fileHandlers } from "./ipc-handlers/files"
import { menuHandlers } from "./ipc-handlers/menu"
import { storageHandlers } from "./ipc-handlers/storage"
import { windowHandlers } from "./ipc-handlers/window"
import { IpcPortHandoff, IpcServerProtocolLive } from "./ipc-transport"
import { ApplicationLifecycle } from "./lifecycle"
import { showCliInstaller } from "./native/install-cli"
import { createMenu, disposeMenu, refreshMenu } from "./native/menu"
import { onNativeTranslations } from "./native/translations"
import { DesktopCli } from "./service/desktop-cli"
import { setStorageSnapshotObserver } from "./storage/snapshot"
import { isRendererUrl } from "./windows/scheme"
import { BackgroundService } from "./service/background-service"
import extension from "#desktop-main-extension"
import {
  getNavigationHistory,
  getLastFocusedWindow,
  goToNavigationHistory,
  subscribeNavigationHistory,
  subscribeWebContents,
} from "./windows"

const services = Layer.mergeAll(DesktopFiles.layer, Plugins.layer)

const handlers = Layer.mergeAll(
  appHandlers,
  storageHandlers,
  fileHandlers,
  windowHandlers,
  menuHandlers,
  eventHandlers,
  pluginHandlers,
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
    commandWindow: getLastFocusedWindow,
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
      // Ctrl+R renames the session in the renderer, so the default menu's Reload must not take it.
      contents.setIgnoreMenuShortcuts(
        input.control && !input.meta && !input.shift && !input.alt && input.key.toLowerCase() === "r",
      )

      if (input.type !== "keyDown" || input.key !== "Escape") return
      contents.send(DragCancelEvent)
    })

    const post = () => {
      if (contents.isDestroyed()) return
      const channel = new MessageChannelMain()
      handoff.bind(contents, channel.port1)
      contents.postMessage(IpcTransportPort, null, [channel.port2])
    }

    // A committed document replaces the bound one; its events wait for the port posted when it loads.
    contents.on("did-navigate", (_event, url) => {
      if (isRendererUrl(url)) handoff.prepare(contents)
    })
    contents.on("did-finish-load", post)
    // The first window starts loading before the layers exist and may already be done.

    if (!contents.isLoading() && contents.getURL()) post()
  }

  const stopDisconnects = handoff.onDisconnect(lifecycle.deepLinks.disconnect)
  yield* Effect.addFinalizer(() => Effect.sync(stopDisconnects))
  const stopSnapshots = setStorageSnapshotObserver(handoff.prepare)
  yield* Effect.addFinalizer(() => Effect.sync(stopSnapshots))
  // A language the renderer pushes rebuilds the menu once it is installed.
  const stopTranslations = onNativeTranslations(refreshMenu)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopTranslations()
      disposeMenu()
    }),
  )

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
