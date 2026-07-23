import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const DesktopMenuAction = Schema.Literals([
  "app.checkForUpdates",
  "app.relaunch",
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.delete",
  "edit.selectAll",
  "history.back",
  "history.forward",
  "view.reload",
  "view.toggleDevTools",
  "view.resetZoom",
  "view.zoomIn",
  "view.zoomOut",
  "view.toggleFullscreen",
  "window.new",
  "window.close",
  "window.minimize",
  "window.toggleMaximize",
])

export const MenuRunAction = Rpc.make("MenuRunAction", {
  payload: { action: DesktopMenuAction },
})
export const MenuGetHistory = Rpc.make("MenuGetHistory", {
  success: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      url: Schema.String,
      active: Schema.Boolean,
    }),
  ),
})
export const MenuGoToHistory = Rpc.make("MenuGoToHistory", {
  payload: { index: Schema.Number },
})
export const MenuRpcs = RpcGroup.make(MenuRunAction, MenuGetHistory, MenuGoToHistory)
