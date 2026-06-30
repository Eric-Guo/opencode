import { Effect } from "effect"
import { MenuRpcs } from "../../shared/ipc-rpc"
import { IpcPortHandoff } from "../ipc-transport"
import { ApplicationLifecycle } from "../lifecycle"
import { runDesktopMenuAction } from "../native/menu-actions"
import { getNavigationHistory, getWindowFromWebContents, goToNavigationHistory } from "../windows"
import { sender } from "./context"

export const menuHandlers = MenuRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const lifecycle = yield* ApplicationLifecycle.Service
    return MenuRpcs.of({
      MenuRunAction: ({ action }, context) =>
        Effect.sync(() =>
          runDesktopMenuAction(getWindowFromWebContents(sender(handoff, context)), action, {
            createWindow: lifecycle.createWindow,
            relaunch: lifecycle.relaunch,
          }),
        ),
      MenuGetHistory: (_args, context) =>
        Effect.sync(() => getNavigationHistory(getWindowFromWebContents(sender(handoff, context)))),
      MenuGoToHistory: ({ index }, context) =>
        Effect.sync(() => goToNavigationHistory(getWindowFromWebContents(sender(handoff, context)), index)),
    })
  }),
)
