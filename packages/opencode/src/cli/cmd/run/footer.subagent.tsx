/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import "opentui-spinner/solid"
import { For, createMemo, createSignal } from "solid-js"
import { SPINNER_FRAMES } from "../tui/component/spinner"
import { RunEntryContent, sameEntryGroup } from "./scrollback.writer"
import type { FooterSubagentDetail, FooterSubagentTab, RunDiffStyle } from "./types"
import type { RunFooterTheme, RunTheme } from "./theme"

export const SUBAGENT_TAB_ROWS = 2
export const SUBAGENT_INSPECTOR_ROWS = 8

function statusColor(theme: RunFooterTheme, status: FooterSubagentTab["status"]) {
  if (status === "completed") {
    return theme.success
  }

  if (status === "error") {
    return theme.error
  }

  return theme.highlight
}

function statusIcon(status: FooterSubagentTab["status"]) {
  if (status === "completed") {
    return "●"
  }

  if (status === "error") {
    return "◍"
  }

  return "◔"
}

export function RunFooterSubagentTabs(props: {
  tabs: FooterSubagentTab[]
  selected?: string
  theme: RunFooterTheme
  onToggle: (sessionID: string) => void
}) {
  const [hover, setHover] = createSignal<string>()

  return (
    <box
      id="run-direct-footer-subagent-tabs"
      width="100%"
      height={SUBAGENT_TAB_ROWS}
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      flexDirection="row"
      flexShrink={0}
    >
      <box flexDirection="row" gap={3} flexShrink={1} flexGrow={1}>
        {props.tabs.map((tab) => {
          const active = () => props.selected === tab.sessionID
          const hovered = () => hover() === tab.sessionID
          const emphasized = () => active() || hovered()
          return (
            <box
              paddingRight={1}
              onMouseOver={() => {
                setHover(tab.sessionID)
              }}
              onMouseOut={() => {
                if (hover() === tab.sessionID) {
                  setHover(undefined)
                }
              }}
              onMouseUp={() => {
                props.onToggle(tab.sessionID)
              }}
            >
              <box flexDirection="row" gap={1} width="100%">
                {tab.status === "running" ? (
                  <box flexShrink={0}>
                    <spinner frames={SPINNER_FRAMES} interval={80} color={statusColor(props.theme, tab.status)} />
                  </box>
                ) : (
                  <text fg={statusColor(props.theme, tab.status)} wrapMode="none" truncate flexShrink={0}>
                    {statusIcon(tab.status)}
                  </text>
                )}
                <text fg={emphasized() ? props.theme.text : props.theme.muted} wrapMode="none" truncate>
                  {tab.label}
                </text>
              </box>
            </box>
          )
        })}
      </box>
    </box>
  )
}

export function RunFooterSubagentBody(props: {
  active: () => boolean
  theme: () => RunTheme
  detail: () => FooterSubagentDetail | undefined
  width: () => number
  diffStyle?: RunDiffStyle
  onCycle: (dir: -1 | 1) => void
  onClose: () => void
}) {
  const commits = createMemo(() => props.detail()?.commits ?? [])
  const entries = createMemo(() => {
    return commits().map((commit, index, list) => ({
      commit,
      gap: index > 0 && !sameEntryGroup(list[index - 1], commit),
    }))
  })
  let scroll: ScrollBoxRenderable | undefined

  useKeyboard((event) => {
    if (!props.active()) {
      return
    }

    if (event.name === "escape") {
      event.preventDefault()
      props.onClose()
      return
    }

    if (event.name === "tab") {
      event.preventDefault()
      props.onCycle(event.shift ? -1 : 1)
      return
    }

    if (event.name === "up" || event.name === "k") {
      event.preventDefault()
      scroll?.scrollBy(-1)
      return
    }

    if (event.name === "down" || event.name === "j") {
      event.preventDefault()
      scroll?.scrollBy(1)
    }
  })

  return (
    <box
      id="run-direct-footer-subagent"
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={props.theme().footer.surface}
    >
      <box paddingTop={1} paddingLeft={1} paddingRight={3} paddingBottom={1} flexDirection="column" flexGrow={1}>
        <scrollbox
          width="100%"
          height="100%"
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: props.theme().footer.surface,
              foregroundColor: props.theme().footer.line,
            },
          }}
          ref={(item) => {
            scroll = item as ScrollBoxRenderable
          }}
        >
          <box width="100%" flexDirection="column" gap={0}>
            <For each={entries()}>
              {(item) => (
                <box flexDirection="column" gap={0}>
                  {item.gap ? <box height={1} flexShrink={0} /> : null}
                  <RunEntryContent
                    commit={item.commit}
                    theme={props.theme()}
                    opts={{ diffStyle: props.diffStyle }}
                    width={props.width()}
                  />
                </box>
              )}
            </For>
            {entries().length === 0 ? (
              <text fg={props.theme().footer.muted} wrapMode="word">
                No subagent activity yet
              </text>
            ) : null}
          </box>
        </scrollbox>
      </box>
    </box>
  )
}
