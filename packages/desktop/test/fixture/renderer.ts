import { MessageChannelMain } from "electron"
import type { WebContents } from "electron"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { RpcServer } from "effect/rpc"
import { Ssh, SshState } from "../../../gui-plugins/src/ssh/contract"
import { AppRpcs } from "../../src/shared/ipc-rpc/app"
import { EventRpcs } from "../../src/shared/ipc-rpc/events"
import { PluginRpcs } from "../../src/shared/ipc-rpc/plugins"
import { StorageRpcs } from "../../src/shared/ipc-rpc/storage"
import { WindowRpcs } from "../../src/shared/ipc-rpc/window"
import { IpcTransportPort } from "../../src/shared/ipc-transport"
import { IpcPortHandoff, IpcServerProtocolLive } from "../../src/main/ipc-transport"
import { pluginHandlers } from "../../src/main/ipc-handlers/plugins"
import { Plugins } from "../../src/main/plugin"
import { eventHandlers } from "../../src/main/ipc-handlers/events"
import type { StateStore } from "../../src/main/storage/state"

/** Real renderer/transport with fixture-owned native state and no installed service. */
export async function rendererFixture(url: string, storage?: StateStore, main?: Plugins.Interface) {
  // Built-ins always run. SSH publishes an empty inventory so the server startup gate can settle.
  const plugins = ["ssh", "updater"].map((id) => ({ id, builtin: true, enabled: true }))
  const rpcs = AppRpcs.merge(WindowRpcs, StorageRpcs, EventRpcs, PluginRpcs)
  const settings = { spellcheck: true }

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
      AppGetSpellcheckEnabled: () => Effect.sync(() => settings.spellcheck),
      AppSetSpellcheckEnabled: ({ enabled }) =>
        Effect.sync(() => {
          settings.spellcheck = enabled
        }),
      AppRecordFatalRendererError: ({ error }) => Effect.die(error),
      AppSetNativeTranslations: () => Effect.void,
      AppRelaunch: () => Effect.die("Fixture must not relaunch"),
      AppQuit: () => Effect.die("Fixture must not quit through renderer"),
    }),
    WindowRpcs.toLayer({
      WindowThemeReady: () => Effect.void,
      WindowRequestMicrophone: () => Effect.succeed(false),
      WindowSetVoiceCallActive: () => Effect.void,
      WindowGetFocused: () => Effect.succeed(true),
      WindowGetFullscreen: () => Effect.succeed(false),
      WindowSetFocus: () => Effect.void,
      WindowShow: () => Effect.void,
      WindowGetZoomFactor: () => Effect.succeed(1),
      WindowSetZoomFactor: () => Effect.void,
      WindowGetZoomLevel: () => Effect.succeed(1),
      WindowSetZoomLevel: () => Effect.void,
      WindowGetPinchZoomEnabled: () => Effect.succeed(false),
      WindowSetPinchZoomEnabled: () => Effect.void,
      WindowSetTitlebar: () => Effect.void,
      WindowSetTrafficLightsPosition: () => Effect.void,
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
    main
      ? pluginHandlers.pipe(
          Layer.provide(
            Layer.succeed(Plugins.Service)({
              ...main,
              subscribe: (ipc, window) =>
                ipc === Ssh.id
                  ? { available: true, state: Schema.encodeSync(SshState)({ servers: [], revision: 0 }) }
                  : main.subscribe(ipc, window),
            }),
          ),
        )
      : PluginRpcs.toLayer({
          PluginCall: () => Effect.die("No fixture GUI plugins"),
          PluginSubscribe: ({ ipc }) =>
            Effect.succeed(
              ipc === Ssh.id
                ? { available: true, state: Schema.encodeSync(SshState)({ servers: [], revision: 0 }) }
                : { available: false },
            ),
          PluginEmbed: () => Effect.void,
          PluginCapture: () => Effect.succeed(null),
          PluginMenubarItem: () => Effect.void,
          PluginMenubarItems: () => Effect.succeed([]),
          PluginConfigure: () => Effect.void,
          PluginList: () => Effect.succeed(plugins),
          PluginEnable: () => Effect.void,
          PluginDisable: () => Effect.void,
          PluginReload: () => Effect.void,
          PluginGuis: () => Effect.succeed({ plugins: [], reserved: [] }),
        }),
    eventHandlers,
  )

  const runtime = ManagedRuntime.make(
    RpcServer.layer(rpcs).pipe(Layer.provide(handlers), Layer.provideMerge(IpcServerProtocolLive)),
  )

  const handoff = await runtime.runPromise(IpcPortHandoff)

  return {
    plugins,
    bind(contents: WebContents) {
      contents.on("did-finish-load", async () => {
        // Fixture-only raw wire access exercises the production decoder and caller checks.
        await contents.executeJavaScript(`
          (() => {
            let id = 1000000;
            const port = new Promise(resolve => {
              const receive = event => {
                if (event.source !== window || event.data !== ${JSON.stringify(IpcTransportPort)}) return;
                window.removeEventListener("message", receive);
                resolve(event.ports[0]);
              };
              window.addEventListener("message", receive);
            });
            window.fixtureRpc = async (tag, payload, signal) => {
              const channel = await port;
              const request = id++;
              return new Promise((resolve, reject) => {
                const abort = () => {
                  channel.postMessage({ _tag: "Interrupt", requestId: request });
                  channel.removeEventListener("message", receive);
                  reject(new Error("aborted"));
                };
                const receive = event => {
                  const message = event.data;
                  if (message._tag !== "Exit" || Number(message.requestId) !== request) return;
                  channel.removeEventListener("message", receive);
                  signal?.removeEventListener("abort", abort);
                  if (message.exit._tag === "Success") resolve(message.exit.value);
                  else reject(new Error(JSON.stringify(message.exit.cause)));
                };
                if (signal?.aborted) return reject(new Error("aborted"));
                signal?.addEventListener("abort", abort, { once: true });
                channel.addEventListener("message", receive);
                channel.start();
                channel.postMessage({ _tag: "Request", id: request, tag, payload, headers: [] });
              });
            };
          })()
        `)

        const channel = new MessageChannelMain()
        handoff.bind(contents, channel.port1)
        contents.postMessage(IpcTransportPort, null, [channel.port2])
      })
    },
    dispose: () => runtime.dispose(),
  }
}
