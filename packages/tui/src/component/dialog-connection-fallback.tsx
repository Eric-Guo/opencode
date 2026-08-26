import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

const choices = ["stay", "new"] as const
type Choice = (typeof choices)[number]

export function DialogConnectionFallback(props: {
  previous: string
  promoted: string
  unavailableUntil: number
  onConfirm: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme("elevated")
  const [store, setStore] = createStore({ active: "stay" as Choice })

  function select() {
    if (store.active === "new") props.onConfirm()
    dialog.clear()
  }

  useKeyboard((event) => {
    if (event.name === "return") {
      event.preventDefault()
      event.stopPropagation()
      select()
      return
    }
    if (event.name === "left" || event.name === "right") {
      event.preventDefault()
      event.stopPropagation()
      setStore("active", event.name === "left" ? "stay" : "new")
    }
  })

  return (
    <box gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          Kimi account switched
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingLeft={2} paddingRight={2}>
        <text fg={theme.text.subdued} wrapMode="word">
          {props.previous} reached Kimi's five-hour rolling limit and is unavailable until{" "}
          {new Date(props.unavailableUntil).toLocaleString()}. {props.promoted} is now selected. Start a blank session
          with the same model?
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <For each={choices}>
          {(choice) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={choice === store.active ? theme.background.action.primary.focused : undefined}
              onMouseUp={() => {
                setStore("active", choice)
                select()
              }}
            >
              <text fg={choice === store.active ? theme.text.action.primary.focused : theme.text.subdued}>
                {choice === "new" ? "new session" : "stay"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
