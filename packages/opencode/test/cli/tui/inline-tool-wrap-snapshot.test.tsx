import { afterEach, describe, expect, test } from "bun:test"
import { For } from "solid-js"
import { testRender } from "@opentui/solid"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

const tools = [
  {
    icon: "*",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
  },
  {
    icon: "*",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
  },
  {
    icon: "->",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "->",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
  },
  {
    icon: "*",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
  },
] as const

function InlineToolRow(props: { item: (typeof tools)[number] }) {
  return (
    <box paddingLeft={3} flexDirection="row">
      <text width={props.item.icon.length + 1}>{props.item.icon}</text>
      <text flexGrow={1}>{props.item.label}</text>
    </box>
  )
}

function Fixture() {
  return (
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        <For each={tools}>{(item) => <InlineToolRow item={item} />}</For>
      </box>
    </box>
  )
}

describe("TUI inline tool wrapping", () => {
  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    testSetup = await testRender(() => <Fixture />, { width: 72, height: 12 })
    await testSetup.renderOnce()
    await testSetup.renderOnce()

    expect(
      testSetup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd(),
    ).toMatchSnapshot()
  })
})
