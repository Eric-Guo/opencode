import { TextAttributes, RGBA } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"

// Shadow markers (rendered chars in parens):
// ^ = letter top, shadow bottom (▀ with fg=letter, bg=shadow)
// ~ = shadow top only (▀ with fg=shadow)
const SHADOW_MARKER = /[~^]/

const LOGO_TOP = [
  `                  ___       _______  _______ .__   __. .___________.             `,
  `                 /   \\     /  _____||   ____||  \\ |  | |           |             `,
  `                /  ^  \\   |  |  __  |  |__   |   \\|  | \`---|  |----\`             `,
  `               /  /_\\  \\  |  | |_ | |   __|  |  . \`  |     |  |                  `,
  `              /  _____  \\ |  |__| | |  |____ |  |\\   |     |  |                  `,
  `             /__/     \\__\\ \\______| |_______||__| \\__|     |__|                  `,
]

const LOGO_BOTTOM = [
  `___   ___  __       ___       ______   .___________. __       ___      .__   __. `,
  `\\  \\ /  / |  |     /   \\     /  __  \\  |           ||  |     /   \\     |  \\ |  | `,
  ` \\  V  /  |  |    /  ^  \\   |  |  |  | \`---|  |----\`|  |    /  ^  \\    |   \\|  | `,
  `  >   <   |  |   /  /_\\  \\  |  |  |  |     |  |     |  |   /  /_\\  \\   |  . \`  | `,
  ` /  .  \\  |  |  /  _____  \\ |  \`--'  |     |  |     |  |  /  _____  \\  |  |\\   | `,
  `/__/ \\__\\ |__| /__/     \\__\\ \\______/      |__|     |__| /__/     \\__\\ |__| \\__|`,
]

const LOGO_WIDTH = Math.max(
  ...LOGO_TOP.map((line) => line.length),
  ...LOGO_BOTTOM.map((line) => line.length),
)

const centerLine = (line: string): string => {
  if (line.length >= LOGO_WIDTH) return line

  const totalPadding = LOGO_WIDTH - line.length
  const leftPadding = Math.floor(totalPadding / 2)
  const rightPadding = totalPadding - leftPadding

  return `${" ".repeat(leftPadding)}${line}${" ".repeat(rightPadding)}`
}

export function Logo() {
  const { theme } = useTheme()

  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element[] => {
    const shadow = tint(theme.background, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    const elements: JSX.Element[] = []
    let i = 0

    while (i < line.length) {
      const rest = line.slice(i)
      const markerIndex = rest.search(SHADOW_MARKER)

      if (markerIndex === -1) {
        elements.push(
          <text fg={fg} attributes={attrs} selectable={false}>
            {rest}
          </text>,
        )
        break
      }

      if (markerIndex > 0) {
        elements.push(
          <text fg={fg} attributes={attrs} selectable={false}>
            {rest.slice(0, markerIndex)}
          </text>,
        )
      }

      const marker = rest[markerIndex]
      switch (marker) {
        case "^":
          elements.push(
            <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
              ▀
            </text>,
          )
          break
        case "~":
          elements.push(
            <text fg={shadow} attributes={attrs} selectable={false}>
              ▀
            </text>,
          )
          break
      }

      i += markerIndex + 1
    }

    return elements
  }

  return (
    <box>
      <For each={LOGO_TOP}>
        {(line) => (
          <box flexDirection="row">{renderLine(centerLine(line), theme.textMuted, false)}</box>
        )}
      </For>
      <For each={LOGO_BOTTOM}>
        {(line) => <box flexDirection="row">{renderLine(centerLine(line), theme.text, true)}</box>}
      </For>
    </box>
  )
}
