import { type Component, createResource, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { SettingsList } from "./settings-list"

type PairResult =
  | { enabled: false }
  | {
      enabled: true
      hosts: string[]
      relayURL?: string
      serverID?: string
      relaySecretHash?: string
      link: string
      qr: string
    }

export const SettingsPair: Component = () => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const platform = usePlatform()

  const [data] = createResource(async () => {
    const url = `${globalSDK.url}/experimental/push/pair`
    console.debug("[settings-pair] fetching pair data", {
      serverUrl: globalSDK.url,
      serverName: server.name,
      serverKey: server.key,
    })
    const f = platform.fetch ?? fetch
    const res = await f(url)
    if (!res.ok) {
      console.debug("[settings-pair] pair endpoint returned non-ok", {
        status: res.status,
        serverUrl: globalSDK.url,
      })
      return { enabled: false as const }
    }
    const result = (await res.json()) as PairResult
    console.debug("[settings-pair] pair data received", {
      enabled: result.enabled,
      serverUrl: globalSDK.url,
      serverName: server.name,
      ...(result.enabled
        ? {
            relayURL: result.relayURL,
            serverID: result.serverID,
            relaySecretHash: result.relaySecretHash,
            hostCount: result.hosts.length,
            hosts: result.hosts,
          }
        : {}),
    })
    return result
  })

  return (
    <div class="flex flex-col gap-6 py-4 px-5">
      <div class="flex flex-col gap-1">
        <h2 class="text-16-semibold text-text-strong">{language.t("settings.pair.title")}</h2>
        <p class="text-13-regular text-text-weak">{language.t("settings.pair.description")}</p>
      </div>

      <Show when={data.loading}>
        <SettingsList>
          <div class="flex items-center justify-center py-12">
            <span class="text-14-regular text-text-weak">{language.t("settings.pair.loading")}</span>
          </div>
        </SettingsList>
      </Show>

      <Show when={data.error}>
        <SettingsList>
          <div class="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Icon name="warning" size="large" />
            <div class="flex flex-col gap-1">
              <span class="text-14-medium text-text-strong">{language.t("settings.pair.error.title")}</span>
              <span class="text-13-regular text-text-weak max-w-md">
                {language.t("settings.pair.error.description")}
              </span>
            </div>
          </div>
        </SettingsList>
      </Show>

      <Show when={!data.loading && !data.error && data()}>
        {(result) => (
          <Show
            when={result().enabled && result()}
            fallback={
              <SettingsList>
                <div class="flex flex-col items-center justify-center py-12 gap-3 text-center">
                  <Icon name="link" size="large" />
                  <div class="flex flex-col gap-1">
                    <span class="text-14-medium text-text-strong">{language.t("settings.pair.disabled.title")}</span>
                    <span class="text-13-regular text-text-weak max-w-md">
                      {language.t("settings.pair.disabled.description")}
                    </span>
                  </div>
                  <code class="text-12-regular text-text-weak bg-surface-inset px-3 py-1.5 rounded mt-1">
                    opencode serve --relay-url &lt;url&gt; --relay-secret &lt;secret&gt;
                  </code>
                </div>
              </SettingsList>
            }
          >
            {(pair) => {
              const p = pair() as PairResult & { enabled: true }
              return (
                <SettingsList>
                  <div class="flex flex-col items-center py-8 gap-4">
                    <Show when={server.list.length > 1 || p.relayURL}>
                      <div class="flex flex-col gap-1.5 w-full max-w-sm text-left">
                        <div class="flex items-center gap-2">
                          <span class="text-12-medium text-text-weak shrink-0">
                            {language.t("settings.pair.server.label")}
                          </span>
                          <code class="text-12-regular text-text-default bg-surface-inset px-2 py-0.5 rounded truncate">
                            {server.name}
                          </code>
                        </div>
                        <Show when={p.relayURL}>
                          <div class="flex items-center gap-2">
                            <span class="text-12-medium text-text-weak shrink-0">
                              {language.t("settings.pair.relay.label")}
                            </span>
                            <code class="text-12-regular text-text-default bg-surface-inset px-2 py-0.5 rounded truncate">
                              {p.relayURL}
                            </code>
                          </div>
                        </Show>
                        <Show when={p.relaySecretHash}>
                          <div class="flex items-center gap-2">
                            <span class="text-12-medium text-text-weak shrink-0">
                              {language.t("settings.pair.secret.label")}
                            </span>
                            <code class="text-12-regular text-text-default bg-surface-inset px-2 py-0.5 rounded truncate">
                              {p.relaySecretHash}
                            </code>
                          </div>
                        </Show>
                      </div>
                    </Show>
                    <img src={p.qr} alt="Pairing QR code" class="w-64 h-64" />
                    <div class="flex flex-col gap-1 text-center max-w-sm">
                      <span class="text-14-medium text-text-strong">
                        {language.t("settings.pair.instructions.title")}
                      </span>
                      <span class="text-13-regular text-text-weak">
                        {language.t("settings.pair.instructions.description")}
                      </span>
                    </div>
                  </div>
                </SettingsList>
              )
            }}
          </Show>
        )}
      </Show>
    </div>
  )
}
