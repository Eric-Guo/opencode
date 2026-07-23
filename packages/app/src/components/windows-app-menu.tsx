import { createSignal, For, Show, type JSX } from "solid-js"
import { Menu } from "@opencode-ai/ui/menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"

import { useCommand } from "@/context/command"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuAction,
  type DesktopMenuEntry,
  type DesktopMenuHistoryEntry,
} from "@/desktop-menu"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"

export function WindowsAppMenu(props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
}) {
  let lastFocused: HTMLElement | undefined
  const language = useLanguage()
  const [history, setHistory] = createSignal<DesktopMenuHistoryEntry[]>([])

  const rememberFocus = () => {
    const active = document.activeElement
    lastFocused = active instanceof HTMLElement ? active : undefined
  }
  const commandDisabled = (id: string) => {
    const option = props.command.options.find((option) => option.id === id)
    if (!option) return true
    return option.disabled ?? false
  }
  const runCommand = (id: string) => {
    if (commandDisabled(id)) return
    props.command.trigger(id)
  }
  const runAction = (action: DesktopMenuAction) => {
    if (action.startsWith("edit.") && lastFocused?.isConnected) lastFocused.focus({ preventScroll: true })
    void props.platform.runDesktopMenuAction?.(action)
  }
  const runEntry = (entry: DesktopMenuEntry) => {
    if (entry.type === "separator") return
    if (entry.command) {
      runCommand(entry.command)
      return
    }
    if (entry.action) {
      runAction(entry.action)
      return
    }
    if (entry.href) props.platform.openExternal(entry.href)
  }
  const loadHistory = () => {
    const read = props.platform.getDesktopMenuHistory
    if (!read) {
      setHistory([])
      return
    }
    void read().then(setHistory, () => setHistory([]))
  }

  return (
    <Menu
      appearance="standard"
      gutter={4}
      modal={false}
      placement="bottom-start"
      onOpenChange={(open) => {
        if (open) loadHistory()
      }}
    >
      <div
        data-component="desktop-icon-button"
        class="flex h-7 w-9 shrink-0 items-center justify-center rounded-[6px] px-1"
      >
        <Menu.Trigger
          as={IconButton}
          variant="ghost-muted"
          size="large"
          icon={<Icon name="menu" />}
          aria-label={language.t("desktop.menu.ariaLabel")}
          onPointerDown={rememberFocus}
          onKeyDown={rememberFocus}
        />
      </div>
      <Menu.Portal>
        <Menu.Content class="desktop-app-menu">
          <Menu.Group>
            <Menu.GroupLabel class="desktop-app-menu-heading">Sigma Agents</Menu.GroupLabel>
            <For each={DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "windows"))}>
              {(menu) => (
                <DesktopMenuSubmenu label={language.t(menu.labelKey)}>
                  <For each={menu.items?.filter((entry) => desktopMenuVisible(entry, "windows"))}>
                    {(entry) => {
                      // Static menu data: an early return keeps the union narrowing a Show fallback would lose.
                      if (entry.type === "separator") return <Menu.Separator />
                      return (
                        <DesktopMenuItem
                          label={entry.labelKey ? language.t(entry.labelKey) : ""}
                          keybind={entry.command ? props.command.keybind(entry.command) : entry.accelerator?.windows}
                          disabled={entry.command ? commandDisabled(entry.command) : false}
                          onSelect={() => runEntry(entry)}
                        />
                      )
                    }}
                  </For>
                  <Show when={menu.id === "history" && history().length > 0}>
                    <Menu.Separator />
                    <For each={history()}>
                      {(entry) => (
                        <DesktopMenuItem
                          label={entry.url}
                          title={entry.url}
                          disabled={entry.active}
                          onSelect={() => void props.platform.goToDesktopMenuHistory?.(entry.index)}
                        />
                      )}
                    </For>
                  </Show>
                </DesktopMenuSubmenu>
              )}
            </For>
          </Menu.Group>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

function DesktopMenuSubmenu(props: { label: string; children: JSX.Element }) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger>{props.label}</Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent class="desktop-app-menu desktop-app-menu-sub">{props.children}</Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  )
}

function DesktopMenuItem(props: {
  label: string
  title?: string
  keybind?: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <Menu.Item
      disabled={props.disabled}
      onSelect={props.onSelect}
      shortcut={props.keybind}
      title={props.title}
    >
      {props.label}
    </Menu.Item>
  )
}
