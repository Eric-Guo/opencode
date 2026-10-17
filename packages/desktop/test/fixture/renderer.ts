import { MessageChannelMain } from "electron"
import type { WebContents } from "electron"
import { Effect, Layer, ManagedRuntime } from "effect"
import { RpcServer } from "effect/rpc"
import { AppRpcs } from "../../src/shared/ipc-rpc/app"
import { EventRpcs } from "../../src/shared/ipc-rpc/events"
import { ExtensionRpcs } from "../../src/shared/ipc-rpc/extensions"
import { StorageRpcs } from "../../src/shared/ipc-rpc/storage"
import { WindowRpcs } from "../../src/shared/ipc-rpc/window"
import { IpcTransportPort } from "../../src/shared/ipc-transport"
import { IpcPortHandoff, IpcServerProtocolLive } from "../../src/main/ipc-transport"
import { eventHandlers } from "../../src/main/ipc-handlers/events"
import type { StateStore } from "../../src/main/storage/state"

/** Real renderer/transport with fixture-owned native state and no installed service. */
export async function rendererFixture(url: string, storage?: StateStore) {
  // This fixture has no native SSH/updater hosts; disable them rather than wait for their main stores.
  const extensions = ["ssh", "updater"].map((id) => ({ id, name: id, version: "1", builtin: true, enabled: false }))
  const rpcs = AppRpcs.merge(WindowRpcs, StorageRpcs, EventRpcs, ExtensionRpcs)

  const handlers = Layer.mergeAll(
    AppRpcs.toLayer({
      AppAwaitInitialization: () => Effect.succeed({ url }),
      AppReconnectService: () => Effect.succeed({ url }),
      AppGetCybrosCurrentUser: () => Effect.succeed(null),
      AppConsumeInitialDeepLinks: () => Effect.succeed([]),
      AppIsFirstLaunchOnboardingPending: () => Effect.succeed(false),
      AppFinishFirstLaunchOnboarding: () => Effect.succeed(null),
      AppCheckAppExists: () => Effect.succeed(false),
      AppResolveAppPath: () => Effect.succeed(null),
      AppSetBackgroundColor: () => Effect.void,
      AppExportDebugLogs: () => Effect.succeed(""),
      AppSetForceFocus: () => Effect.void,
      AppRecordFatalRendererError: ({ error }) => Effect.die(error),
      AppSetNativeTranslations: () => Effect.void,
      AppRelaunch: () => Effect.die("Fixture must not relaunch"),
      AppQuit: () => Effect.die("Fixture must not quit through renderer"),
    }),
    WindowRpcs.toLayer({
      WindowThemeReady: () => Effect.void,
      WindowGetFocused: () => Effect.succeed(true),
      WindowGetFullscreen: () => Effect.succeed(false),
      WindowSetFocus: () => Effect.void,
      WindowShow: () => Effect.void,
      WindowGetZoomFactor: () => Effect.succeed(1),
      WindowSetZoomFactor: () => Effect.void,
      WindowGetPinchZoomEnabled: () => Effect.succeed(false),
      WindowSetPinchZoomEnabled: () => Effect.void,
      WindowSetTitlebar: () => Effect.void,
    }),
    StorageRpcs.toLayer({
      StorageItems: ({ name }) => Effect.sync(() => storage?.items(name) ?? { items: {}, revision: 0 }),
      StorageUpdate: ({ name, insert, remove }) => Effect.sync(() => storage?.update(name, insert, remove) ?? 1),
      StorageClear: ({ name }) => Effect.sync(() => storage?.clear(name)),
      DraftsGet: () => Effect.succeed(null),
      DraftsSet: () => Effect.succeed([]),
      DraftsDelete: () => Effect.void,
      DraftsPutBlob: () => Effect.die("Fixture must not write attachments"),
      DraftsGetBlob: () => Effect.succeed(null),
    }),
    ExtensionRpcs.toLayer({
      ExtensionCall: () => Effect.die("No fixture GUI extensions"),
      ExtensionSubscribe: () => Effect.succeed({ available: false }),
      ExtensionEmbed: () => Effect.void,
      ExtensionCapture: () => Effect.succeed(null),
      ExtensionMenubarItem: () => Effect.void,
      ExtensionMenubarItems: () => Effect.succeed([]),
      ExtensionConfigure: () => Effect.void,
      ExtensionList: () => Effect.succeed(extensions),
      ExtensionEnable: () => Effect.void,
      ExtensionDisable: () => Effect.void,
      ExtensionReload: () => Effect.void,
      ExtensionInstall: () => Effect.void,
      ExtensionRemove: () => Effect.void,
      ExtensionSource: () => Effect.succeed(""),
    }),
    eventHandlers,
  )

  const runtime = ManagedRuntime.make(
    RpcServer.layer(rpcs).pipe(Layer.provide(handlers), Layer.provideMerge(IpcServerProtocolLive)),
  )

  const handoff = await runtime.runPromise(IpcPortHandoff)

  return {
    extensions,
    bind(contents: WebContents) {
      contents.on("did-finish-load", () => {
        const channel = new MessageChannelMain()
        handoff.bind(contents, channel.port1)
        contents.postMessage(IpcTransportPort, null, [channel.port2])
      })
    },
    dispose: () => runtime.dispose(),
  }
}
