import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useSyncV2 } from "@tui/context/sync-v2"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, For, Show } from "solid-js"

const id = "internal:session-v2-debug"
const route = "session.v2.messages"

function currentSessionID(api: TuiPluginApi) {
  const current = api.route.current
  if (current.name !== "session") return
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSyncV2()
  const dimensions = useTerminalDimensions()
  const messages = createMemo(() => sync.data.messages[props.sessionID] ?? [])

  createEffect(() => {
    void sync.session.message.sync(props.sessionID)
  })

  useKeyboard((event) => {
    if (event.name !== "escape") return
    event.preventDefault()
    event.stopPropagation()
    props.api.route.navigate("session", { sessionID: props.sessionID })
  })

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={props.api.theme.current.background}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={props.api.theme.current.primary}>
            <b>V2 Messages</b>
          </text>
          <text fg={props.api.theme.current.textMuted}>{props.sessionID}</text>
          <text fg={props.api.theme.current.textMuted}>({messages().length})</text>
        </box>
        <text fg={props.api.theme.current.textMuted} flexShrink={0}>
          Esc returns to the session. Data below is read from useSyncV2 after syncing from the v2 endpoint.
        </text>
        <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true }}>
          <box gap={1} paddingRight={1}>
            <Show when={messages().length === 0}>
              <text fg={props.api.theme.current.textMuted}>No v2 messages loaded.</text>
            </Show>
            <For each={messages()}>
              {(message, index) => (
                <box
                  borderColor={props.api.theme.current.border}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <box flexDirection="row" gap={1}>
                    <text fg={props.api.theme.current.accent}>#{index() + 1}</text>
                    <text fg={props.api.theme.current.text}>{message.type}</text>
                    <text fg={props.api.theme.current.textMuted}>{message.id}</text>
                  </box>
                  <text fg={props.api.theme.current.text}>{JSON.stringify(message, null, 2)}</text>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: route,
      render(input) {
        const sessionID = input.params?.sessionID
        if (typeof sessionID !== "string") {
          return <text fg={api.theme.current.error}>Missing sessionID</text>
        }
        return <View api={api} sessionID={sessionID} />
      },
    },
  ])

  api.command.register(() => [
    {
      title: "View v2 session messages",
      value: route,
      category: "Debug",
      suggested: api.route.current.name === "session",
      enabled: api.route.current.name === "session",
      onSelect() {
        const sessionID = currentSessionID(api)
        if (!sessionID) return
        api.route.navigate(route, { sessionID })
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
