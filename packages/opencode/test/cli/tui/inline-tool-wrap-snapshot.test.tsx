import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, For } from "solid-js"
import { testRender } from "@opentui/solid"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

const tools = [
  {
    kind: "grep",
    icon: "*",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
    target: '"OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA"',
    meta: "packages/opencode/src - 151 matches",
  },
  {
    kind: "glob",
    icon: "*",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
    target: '"**/*db*"',
    meta: "packages/opencode - 6 matches",
  },
  {
    kind: "read",
    icon: "->",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
    target: "packages/opencode/src/storage/db.ts",
    meta: "offset=1, limit=130",
  },
  {
    kind: "read",
    icon: "->",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
    target: "packages/opencode/src/index.ts",
    meta: "offset=1, limit=100",
  },
  {
    kind: "grep",
    icon: "*",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
    target: '"export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data ="',
    meta: "packages/opencode/src - 115 matches",
  },
] as const

function CurrentInlineRow(props: { item: (typeof tools)[number]; index: number }) {
  const [margin, setMargin] = createSignal(0)

  return (
    <box
      id={`current-${props.index}`}
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const parent = this.parent
        if (!parent) return
        if (this.height > 1) {
          setMargin(1)
          return
        }
        const previous = parent.getChildren()[parent.getChildren().indexOf(this) - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) setMargin(1)
      }}
    >
      <text paddingLeft={3}>
        {props.item.icon} {props.item.label}
      </text>
    </box>
  )
}

function StableInlineRow(props: { item: (typeof tools)[number] }) {
  return (
    <box paddingLeft={3}>
      <text paddingLeft={3}>
        {props.item.icon} {props.item.label}
      </text>
    </box>
  )
}

function HangingIndentRow(props: { item: (typeof tools)[number] }) {
  return (
    <box paddingLeft={3} flexDirection="row">
      <text width={props.item.icon.length + 1}>{props.item.icon}</text>
      <text flexGrow={1}>{props.item.label}</text>
    </box>
  )
}

function DetailRow(props: { item: (typeof tools)[number] }) {
  return (
    <box paddingLeft={3}>
      <text paddingLeft={3}>
        {props.item.icon} {titlecase(props.item.kind)} {props.item.target}
      </text>
      <text paddingLeft={6}>{props.item.meta}</text>
    </box>
  )
}

function CompactRow(props: { item: (typeof tools)[number] }) {
  return (
    <box paddingLeft={3}>
      <text paddingLeft={3} wrapMode="none">
        {props.item.icon} {titlecase(props.item.kind)} {truncateMiddle(props.item.target, 34)} -{" "}
        {truncateMiddle(props.item.meta, 32)}
      </text>
    </box>
  )
}

function Fixture() {
  return (
    <box flexDirection="column" width={72}>
      <text>CURRENT: measured height adds top margin after wrapped rows</text>
      <box flexDirection="column">
        <For each={tools}>{(item, index) => <CurrentInlineRow item={item} index={index()} />}</For>
      </box>
      <text marginTop={2}>STABLE WRAP: no height-coupled margin</text>
      <box flexDirection="column">
        <For each={tools}>{(item) => <StableInlineRow item={item} />}</For>
      </box>
      <text marginTop={2}>HANGING INDENT: wrap aligns with tool text</text>
      <box flexDirection="column">
        <For each={tools}>{(item) => <HangingIndentRow item={item} />}</For>
      </box>
      <text marginTop={2}>DETAIL ROWS: split identity from metadata</text>
      <box flexDirection="column">
        <For each={tools}>{(item) => <DetailRow item={item} />}</For>
      </box>
      <text marginTop={2}>COMPACT: truncate middle, never wrap</text>
      <box flexDirection="column">
        <For each={tools}>{(item) => <CompactRow item={item} />}</For>
      </box>
    </box>
  )
}

describe("TUI inline tool wrapping", () => {
  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    testSetup = await testRender(() => <Fixture />, { width: 72, height: 60 })
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

function titlecase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function truncateMiddle(value: string, max: number) {
  if (value.length <= max) return value
  return value.slice(0, Math.floor((max - 3) / 2)) + "..." + value.slice(value.length - Math.ceil((max - 3) / 2))
}
