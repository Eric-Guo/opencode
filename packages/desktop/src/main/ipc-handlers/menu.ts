import { Effect } from "effect"
import { MenuRpcs } from "../../shared/ipc-rpc"
import { IpcPortHandoff } from "../ipc-transport"
import { ApplicationLifecycle } from "../lifecycle"
import { runDesktopMenuAction } from "../native/menu-actions"
import { Updater } from "../updater"
import { getDesktopTabHistory, getWindowFromWebContents, goToDesktopTabHistory } from "../windows"
import { sender } from "./context"

export const menuHandlers = MenuRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const lifecycle = yield* ApplicationLifecycle.Service
    const updater = yield* Updater.Service
    const runFork = Effect.runForkWith(yield* Effect.context())
    return MenuRpcs.of({
      MenuRunAction: ({ action }, context) =>
        Effect.sync(() =>
          runDesktopMenuAction(getWindowFromWebContents(sender(handoff, context)), action, {
            checkForUpdates: () => runFork(updater.show),
            createWindow: lifecycle.createWindow,
            relaunch: lifecycle.relaunch,
          }),
        ),
      MenuGetHistory: (_args, context) =>
        Effect.sync(() => getDesktopTabHistory(getWindowFromWebContents(sender(handoff, context)))),
      MenuGoToHistory: ({ index }, context) =>
        Effect.sync(() => goToDesktopTabHistory(getWindowFromWebContents(sender(handoff, context)), index)),
    })
  }),
)
