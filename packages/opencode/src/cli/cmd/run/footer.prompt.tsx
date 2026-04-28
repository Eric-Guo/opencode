// Prompt textarea component and its state machine for direct interactive mode.
//
// createPromptState() wires keybinds, history navigation, leader-key sequences,
// and direct-mode `@` autocomplete for files, subagents, and MCP resources.
// It produces a PromptState that RunPromptBody renders as an OpenTUI textarea,
// while RunPromptAutocomplete renders a fixed-height suggestion list below it.
/** @jsxImportSource @opentui/solid */
import { pathToFileURL } from "bun"
import { StyledText, bg, fg, type KeyBinding, type KeyEvent, type TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import path from "path"
import {
  Index,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js"
import * as Locale from "@/util/locale"
import {
  createPromptHistory,
  isExitCommand,
  movePromptHistory,
  promptCycle,
  promptHit,
  promptInfo,
  promptKeys,
  pushPromptHistory,
} from "./prompt.shared"
import type { FooterKeybinds, FooterState, RunAgent, RunPrompt, RunPromptPart, RunResource } from "./types"
import type { RunFooterTheme } from "./theme"

const LEADER_TIMEOUT_MS = 2000
const AUTOCOMPLETE_ROWS = 6

const EMPTY_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const TEXTAREA_MIN_ROWS = 1
export const TEXTAREA_MAX_ROWS = 6
export const PROMPT_MAX_ROWS = TEXTAREA_MAX_ROWS + AUTOCOMPLETE_ROWS - 1

export const HINT_BREAKPOINTS = {
  send: 50,
  newline: 66,
  history: 80,
  variant: 95,
}

type Mention = Extract<RunPromptPart, { type: "file" | "agent" }>

type Auto = {
  display: string
  value: string
  part: Mention
  description?: string
  directory?: boolean
}

type PromptInput = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: Accessor<RunAgent[]>
  resources: Accessor<RunResource[]>
  keybinds: FooterKeybinds
  state: Accessor<FooterState>
  view: Accessor<string>
  prompt: Accessor<boolean>
  width: Accessor<number>
  theme: Accessor<RunFooterTheme>
  history?: RunPrompt[]
  onSubmit: (input: RunPrompt) => boolean | Promise<boolean>
  onCycle: () => void
  onInterrupt: () => boolean
  onExitRequest?: () => boolean
  onExit: () => void
  onRows: (rows: number) => void
  onStatus: (text: string) => void
}

export type PromptState = {
  placeholder: Accessor<StyledText | string>
  bindings: Accessor<KeyBinding[]>
  visible: Accessor<boolean>
  options: Accessor<Auto[]>
  selected: Accessor<number>
  onSubmit: () => void
  onKeyDown: (event: KeyEvent) => void
  onContentChange: () => void
  bind: (area?: TextareaRenderable) => void
}

function clamp(rows: number): number {
  return Math.max(TEXTAREA_MIN_ROWS, Math.min(TEXTAREA_MAX_ROWS, rows))
}

function clonePrompt(prompt: RunPrompt): RunPrompt {
  return {
    text: prompt.text,
    parts: structuredClone(prompt.parts),
  }
}

function removeLineRange(input: string) {
  const hash = input.lastIndexOf("#")
  return hash === -1 ? input : input.slice(0, hash)
}

function extractLineRange(input: string) {
  const hash = input.lastIndexOf("#")
  if (hash === -1) {
    return { base: input }
  }

  const base = input.slice(0, hash)
  const line = input.slice(hash + 1)
  const match = line.match(/^(\d+)(?:-(\d*))?$/)
  if (!match) {
    return { base }
  }

  const start = Number(match[1])
  const end = match[2] && start < Number(match[2]) ? Number(match[2]) : undefined
  return { base, line: { start, end } }
}

export function hintFlags(width: number) {
  return {
    send: width >= HINT_BREAKPOINTS.send,
    newline: width >= HINT_BREAKPOINTS.newline,
    history: width >= HINT_BREAKPOINTS.history,
    variant: width >= HINT_BREAKPOINTS.variant,
  }
}

export function RunPromptBody(props: {
  theme: () => RunFooterTheme
  placeholder: () => StyledText | string
  bindings: () => KeyBinding[]
  onSubmit: () => void
  onKeyDown: (event: KeyEvent) => void
  onContentChange: () => void
  bind: (area?: TextareaRenderable) => void
}) {
  let area: TextareaRenderable | undefined

  onMount(() => {
    props.bind(area)
  })

  onCleanup(() => {
    props.bind(undefined)
  })

  return (
    <box id="run-direct-footer-prompt" width="100%">
      <box id="run-direct-footer-input-shell" paddingTop={1} paddingLeft={2} paddingRight={2}>
        <textarea
          id="run-direct-footer-composer"
          width="100%"
          minHeight={TEXTAREA_MIN_ROWS}
          maxHeight={TEXTAREA_MAX_ROWS}
          wrapMode="word"
          placeholder={props.placeholder()}
          placeholderColor={props.theme().muted}
          textColor={props.theme().text}
          focusedTextColor={props.theme().text}
          backgroundColor={props.theme().surface}
          focusedBackgroundColor={props.theme().surface}
          cursorColor={props.theme().text}
          keyBindings={props.bindings()}
          onSubmit={props.onSubmit}
          onKeyDown={props.onKeyDown}
          onContentChange={props.onContentChange}
          ref={(next) => {
            area = next
          }}
        />
      </box>
    </box>
  )
}

export function RunPromptAutocomplete(props: {
  theme: () => RunFooterTheme
  options: () => Auto[]
  selected: () => number
}) {
  return (
    <box
      id="run-direct-footer-complete"
      width="100%"
      height={AUTOCOMPLETE_ROWS}
      border={["left"]}
      borderColor={props.theme().border}
      customBorderChars={{
        ...EMPTY_BORDER,
        vertical: "┃",
      }}
    >
      <box
        id="run-direct-footer-complete-fill"
        width="100%"
        height={AUTOCOMPLETE_ROWS}
        flexDirection="column"
        backgroundColor={props.theme().pane}
      >
        <Index
          each={props.options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={props.theme().muted}>No matching items</text>
            </box>
          }
        >
          {(item, index) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              flexDirection="row"
              gap={1}
              backgroundColor={index === props.selected() ? props.theme().highlight : undefined}
            >
              <text
                fg={index === props.selected() ? props.theme().surface : props.theme().text}
                wrapMode="none"
                truncate
              >
                {item().display}
              </text>
              <Show when={item().description}>
                <text
                  fg={index === props.selected() ? props.theme().surface : props.theme().muted}
                  wrapMode="none"
                  truncate
                >
                  {item().description}
                </text>
              </Show>
            </box>
          )}
        </Index>
      </box>
    </box>
  )
}

export function createPromptState(input: PromptInput): PromptState {
  const keys = createMemo(() => promptKeys(input.keybinds))
  const bindings = createMemo(() => keys().bindings)
  const placeholder = createMemo(() => {
    if (!input.state().first) {
      return ""
    }

    return new StyledText([
      bg(input.theme().surface)(fg(input.theme().muted)('Ask anything... "Fix a TODO in the codebase"')),
    ])
  })

  let history = createPromptHistory(input.history)
  let draft: RunPrompt = { text: "", parts: [] }
  let stash: RunPrompt = { text: "", parts: [] }
  let area: TextareaRenderable | undefined
  let leader = false
  let timeout: NodeJS.Timeout | undefined
  let tick = false
  let prev = input.view()
  let type = 0
  let parts: Mention[] = []
  let marks = new Map<number, number>()

  const [visible, setVisible] = createSignal(false)
  const [at, setAt] = createSignal(0)
  const [selected, setSelected] = createSignal(0)
  const [query, setQuery] = createSignal("")

  const width = createMemo(() => Math.max(20, input.width() - 8))
  const agents = createMemo<Auto[]>(() => {
    return input
      .agents()
      .filter((item) => !item.hidden && item.mode !== "primary")
      .map((item) => ({
        display: "@" + item.name,
        value: item.name,
        part: {
          type: "agent",
          name: item.name,
          source: {
            start: 0,
            end: 0,
            value: "",
          },
        },
      }))
  })
  const resources = createMemo<Auto[]>(() => {
    return input.resources().map((item) => ({
      display: Locale.truncateMiddle(`@${item.name} (${item.uri})`, width()),
      value: item.name,
      description: item.description,
      part: {
        type: "file",
        mime: item.mimeType ?? "text/plain",
        filename: item.name,
        url: item.uri,
        source: {
          type: "resource",
          clientName: item.client,
          uri: item.uri,
          text: {
            start: 0,
            end: 0,
            value: "",
          },
        },
      },
    }))
  })
  const [files] = createResource(
    query,
    async (value) => {
      if (!visible()) {
        return []
      }

      const next = extractLineRange(value)
      const list = await input.findFiles(next.base)
      return list
        .sort((a, b) => {
          const dir = Number(b.endsWith("/")) - Number(a.endsWith("/"))
          if (dir !== 0) {
            return dir
          }

          const depth = a.split("/").length - b.split("/").length
          if (depth !== 0) {
            return depth
          }

          return a.localeCompare(b)
        })
        .map((item): Auto => {
          const url = pathToFileURL(path.resolve(input.directory, item))
          let filename = item
          if (next.line && !item.endsWith("/")) {
            filename = `${item}#${next.line.start}${next.line.end ? `-${next.line.end}` : ""}`
            url.searchParams.set("start", String(next.line.start))
            if (next.line.end !== undefined) {
              url.searchParams.set("end", String(next.line.end))
            }
          }

          return {
            display: Locale.truncateMiddle("@" + filename, width()),
            value: filename,
            directory: item.endsWith("/"),
            part: {
              type: "file",
              mime: item.endsWith("/") ? "application/x-directory" : "text/plain",
              filename,
              url: url.href,
              source: {
                type: "file",
                path: item,
                text: {
                  start: 0,
                  end: 0,
                  value: "",
                },
              },
            },
          }
        })
    },
    { initialValue: [] as Auto[] },
  )
  const options = createMemo(() => {
    const mixed = [...agents(), ...files(), ...resources()]
    if (!query()) {
      return mixed.slice(0, AUTOCOMPLETE_ROWS)
    }

    return fuzzysort
      .go(removeLineRange(query()), mixed, {
        keys: [(item) => (item.value || item.display).trimEnd(), "description"],
        limit: AUTOCOMPLETE_ROWS,
      })
      .map((item) => item.obj)
  })
  const popup = createMemo(() => {
    return visible() ? AUTOCOMPLETE_ROWS - 1 : 0
  })

  const clear = () => {
    leader = false
    if (!timeout) {
      return
    }

    clearTimeout(timeout)
    timeout = undefined
  }

  const arm = () => {
    clear()
    leader = true
    timeout = setTimeout(() => {
      clear()
    }, LEADER_TIMEOUT_MS)
  }

  const hide = () => {
    setVisible(false)
    setQuery("")
    setSelected(0)
  }

  const syncRows = () => {
    if (!area || area.isDestroyed) {
      return
    }

    input.onRows(clamp(area.virtualLineCount || 1) + popup())
  }

  const scheduleRows = () => {
    if (tick) {
      return
    }

    tick = true
    queueMicrotask(() => {
      tick = false
      syncRows()
    })
  }

  const syncParts = () => {
    if (!area || area.isDestroyed || type === 0) {
      return
    }

    const next: Mention[] = []
    const map = new Map<number, number>()
    for (const item of area.extmarks.getAllForTypeId(type)) {
      const idx = marks.get(item.id)
      if (idx === undefined) {
        continue
      }

      const part = parts[idx]
      if (!part) {
        continue
      }

      const text = area.plainText.slice(item.start, item.end)
      const prev =
        part.type === "agent"
          ? (part.source?.value ?? "@" + part.name)
          : (part.source?.text.value ?? "@" + (part.filename ?? ""))
      if (text !== prev) {
        continue
      }

      const copy = structuredClone(part)
      if (copy.type === "agent") {
        copy.source = {
          start: item.start,
          end: item.end,
          value: text,
        }
      }
      if (copy.type === "file" && copy.source?.text) {
        copy.source.text.start = item.start
        copy.source.text.end = item.end
        copy.source.text.value = text
      }

      map.set(item.id, next.length)
      next.push(copy)
    }

    const stale = map.size !== marks.size
    parts = next
    marks = map
    if (stale) {
      restoreParts(next)
    }
  }

  const clearParts = () => {
    if (area && !area.isDestroyed) {
      area.extmarks.clear()
    }
    parts = []
    marks = new Map()
  }

  const restoreParts = (value: RunPromptPart[]) => {
    clearParts()
    parts = value
      .filter((item): item is Mention => item.type === "file" || item.type === "agent")
      .map((item) => structuredClone(item))
    if (!area || area.isDestroyed || type === 0) {
      return
    }

    const box = area
    parts.forEach((item, idx) => {
      const start = item.type === "agent" ? item.source?.start : item.source?.text.start
      const end = item.type === "agent" ? item.source?.end : item.source?.text.end
      if (start === undefined || end === undefined) {
        return
      }

      const id = box.extmarks.create({
        start,
        end,
        virtual: true,
        typeId: type,
      })
      marks.set(id, idx)
    })
  }

  const restore = (value: RunPrompt, cursor = value.text.length) => {
    draft = clonePrompt(value)
    if (!area || area.isDestroyed) {
      return
    }

    hide()
    area.setText(value.text)
    restoreParts(value.parts)
    area.cursorOffset = Math.min(cursor, area.plainText.length)
    scheduleRows()
    area.focus()
  }

  const refresh = () => {
    if (!area || area.isDestroyed) {
      return
    }

    const cursor = area.cursorOffset
    const text = area.plainText
    if (visible()) {
      if (cursor <= at() || /\s/.test(text.slice(at(), cursor))) {
        hide()
        return
      }

      setQuery(text.slice(at() + 1, cursor))
      return
    }

    if (cursor === 0) {
      return
    }

    const head = text.slice(0, cursor)
    const idx = head.lastIndexOf("@")
    if (idx === -1) {
      return
    }

    const before = idx === 0 ? undefined : head[idx - 1]
    const tail = head.slice(idx)
    if ((before === undefined || /\s/.test(before)) && !/\s/.test(tail)) {
      setAt(idx)
      setSelected(0)
      setVisible(true)
      setQuery(head.slice(idx + 1))
    }
  }

  const bind = (next?: TextareaRenderable) => {
    if (area === next) {
      return
    }

    if (area && !area.isDestroyed) {
      area.off("line-info-change", scheduleRows)
    }

    area = next
    if (!area || area.isDestroyed) {
      return
    }

    if (type === 0) {
      type = area.extmarks.registerType("run-direct-prompt-part")
    }
    area.on("line-info-change", scheduleRows)
    queueMicrotask(() => {
      if (!area || area.isDestroyed || !input.prompt()) {
        return
      }

      restore(draft)
      refresh()
    })
  }

  const syncDraft = () => {
    if (!area || area.isDestroyed) {
      return
    }

    syncParts()
    draft = {
      text: area.plainText,
      parts: structuredClone(parts),
    }
  }

  const push = (value: RunPrompt) => {
    history = pushPromptHistory(history, value)
  }

  const move = (dir: -1 | 1, event: KeyEvent) => {
    if (!area || area.isDestroyed) {
      return
    }

    if (history.index === null && dir === -1) {
      stash = clonePrompt(draft)
    }

    const next = movePromptHistory(history, dir, area.plainText, area.cursorOffset)
    if (!next.apply || next.text === undefined || next.cursor === undefined) {
      return
    }

    history = next.state
    const value =
      next.state.index === null ? stash : (next.state.items[next.state.index] ?? { text: next.text, parts: [] })
    restore(value, next.cursor)
    event.preventDefault()
  }

  const cycle = (event: KeyEvent): boolean => {
    const next = promptCycle(leader, promptInfo(event), keys().leaders, keys().cycles)
    if (!next.consume) {
      return false
    }

    if (next.clear) {
      clear()
    }

    if (next.arm) {
      arm()
    }

    if (next.cycle) {
      input.onCycle()
    }

    event.preventDefault()
    return true
  }

  const select = (item?: Auto) => {
    const next = item ?? options()[selected()]
    if (!next || !area || area.isDestroyed) {
      return
    }

    const cursor = area.cursorOffset
    const tail = area.plainText.at(cursor)
    const append = "@" + next.value + (tail === " " ? "" : " ")
    area.cursorOffset = at()
    const start = area.logicalCursor
    area.cursorOffset = cursor
    const end = area.logicalCursor
    area.deleteRange(start.row, start.col, end.row, end.col)
    area.insertText(append)

    const text = "@" + next.value
    const startOffset = at()
    const endOffset = startOffset + Bun.stringWidth(text)
    const part = structuredClone(next.part)
    if (part.type === "agent") {
      part.source = {
        start: startOffset,
        end: endOffset,
        value: text,
      }
    }
    if (part.type === "file" && part.source?.text) {
      part.source.text.start = startOffset
      part.source.text.end = endOffset
      part.source.text.value = text
    }

    if (part.type === "file") {
      const prev = parts.findIndex((item) => item.type === "file" && item.url === part.url)
      if (prev !== -1) {
        const mark = [...marks.entries()].find((item) => item[1] === prev)?.[0]
        if (mark !== undefined) {
          area.extmarks.delete(mark)
        }
        parts = parts.filter((_, idx) => idx !== prev)
        marks = new Map(
          [...marks.entries()]
            .filter((item) => item[0] !== mark)
            .map((item) => [item[0], item[1] > prev ? item[1] - 1 : item[1]]),
        )
      }
    }

    const id = area.extmarks.create({
      start: startOffset,
      end: endOffset,
      virtual: true,
      typeId: type,
    })
    marks.set(id, parts.length)
    parts.push(part)
    hide()
    syncDraft()
    scheduleRows()
    area.focus()
  }

  const expand = () => {
    const next = options()[selected()]
    if (!next?.directory || !area || area.isDestroyed) {
      return
    }

    const cursor = area.cursorOffset
    area.cursorOffset = at()
    const start = area.logicalCursor
    area.cursorOffset = cursor
    const end = area.logicalCursor
    area.deleteRange(start.row, start.col, end.row, end.col)
    area.insertText("@" + next.value)
    syncDraft()
    refresh()
  }

  const onKeyDown = (event: KeyEvent) => {
    if (visible()) {
      const name = event.name.toLowerCase()
      const ctrl = event.ctrl && !event.meta && !event.shift
      if (name === "up" || (ctrl && name === "p")) {
        event.preventDefault()
        if (options().length > 0) {
          setSelected((selected() - 1 + options().length) % options().length)
        }
        return
      }

      if (name === "down" || (ctrl && name === "n")) {
        event.preventDefault()
        if (options().length > 0) {
          setSelected((selected() + 1) % options().length)
        }
        return
      }

      if (name === "escape") {
        event.preventDefault()
        hide()
        return
      }

      if (name === "return") {
        event.preventDefault()
        select()
        return
      }

      if (name === "tab") {
        event.preventDefault()
        if (options()[selected()]?.directory) {
          expand()
          return
        }

        select()
        return
      }
    }

    if (event.ctrl && event.name === "c") {
      const handled = input.onExitRequest ? input.onExitRequest() : (input.onExit(), true)
      if (handled) {
        event.preventDefault()
      }
      return
    }

    const key = promptInfo(event)
    if (promptHit(keys().interrupts, key)) {
      if (input.onInterrupt()) {
        event.preventDefault()
        return
      }
    }

    if (cycle(event)) {
      return
    }

    const up = promptHit(keys().previous, key)
    const down = promptHit(keys().next, key)
    if (!up && !down) {
      return
    }

    if (!area || area.isDestroyed) {
      return
    }

    const dir = up ? -1 : 1
    if ((dir === -1 && area.cursorOffset === 0) || (dir === 1 && area.cursorOffset === area.plainText.length)) {
      move(dir, event)
      return
    }

    if (dir === -1 && area.visualCursor.visualRow === 0) {
      area.cursorOffset = 0
    }

    const end =
      typeof area.height === "number" && Number.isFinite(area.height) && area.height > 0
        ? area.height - 1
        : Math.max(0, area.virtualLineCount - 1)
    if (dir === 1 && area.visualCursor.visualRow === end) {
      area.cursorOffset = area.plainText.length
    }
  }

  useKeyboard((event) => {
    if (input.prompt()) {
      return
    }

    if (event.ctrl && event.name === "c") {
      const handled = input.onExitRequest ? input.onExitRequest() : (input.onExit(), true)
      if (handled) {
        event.preventDefault()
      }
    }
  })

  const onSubmit = () => {
    if (!area || area.isDestroyed) {
      return
    }

    if (visible()) {
      select()
      return
    }

    syncDraft()
    const next = clonePrompt(draft)
    if (!next.text.trim()) {
      input.onStatus(input.state().phase === "running" ? "waiting for current response" : "empty prompt ignored")
      return
    }

    if (isExitCommand(next.text)) {
      input.onExit()
      return
    }

    area.setText("")
    clearParts()
    hide()
    draft = { text: "", parts: [] }
    scheduleRows()
    area.focus()
    queueMicrotask(async () => {
      if (await input.onSubmit(next)) {
        push(next)
        return
      }

      restore(next)
    })
  }

  onCleanup(() => {
    clear()
    if (area && !area.isDestroyed) {
      area.off("line-info-change", scheduleRows)
    }
  })

  createEffect(() => {
    input.width()
    popup()
    if (input.prompt()) {
      scheduleRows()
    }
  })

  createEffect(() => {
    query()
    setSelected(0)
  })

  createEffect(() => {
    input.state().phase
    if (!input.prompt() || !area || area.isDestroyed || input.state().phase !== "idle") {
      return
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed) {
        return
      }

      area.focus()
    })
  })

  createEffect(() => {
    const kind = input.view()
    if (kind === prev) {
      return
    }

    if (prev === "prompt") {
      syncDraft()
    }

    clear()
    hide()
    prev = kind
    if (kind !== "prompt") {
      return
    }

    queueMicrotask(() => {
      restore(draft)
    })
  })

  return {
    placeholder,
    bindings,
    visible,
    options,
    selected,
    onSubmit,
    onKeyDown,
    onContentChange: () => {
      syncDraft()
      refresh()
      scheduleRows()
    },
    bind,
  }
}
