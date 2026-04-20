// Pure state machine for the prompt input.
//
// Handles keybind parsing, history ring navigation, and the leader-key
// sequence for variant cycling. All functions are pure -- they take state
// in and return new state out, with no side effects.
//
// The history ring (PromptHistoryState) stores past prompts and tracks
// the current browse position. When the user arrows up at cursor offset 0,
// the current draft is saved and history begins. Arrowing past the end
// restores the draft.
//
// The leader-key cycle (promptCycle) uses a two-step pattern: first press
// arms the leader, second press within the timeout fires the action.
import type { KeyBinding } from "@opentui/core"
import * as Keybind from "@/util/keybind"
import type { FooterKeybinds, RunPrompt } from "./types"

const HISTORY_LIMIT = 200

export type PromptHistoryState = {
  items: RunPrompt[]
  index: number | null
  draft: string
}

export type PromptKeys = {
  leaders: Keybind.Info[]
  cycles: Keybind.Info[]
  interrupts: Keybind.Info[]
  previous: Keybind.Info[]
  next: Keybind.Info[]
  bindings: KeyBinding[]
}

export type PromptCycle = {
  arm: boolean
  clear: boolean
  cycle: boolean
  consume: boolean
}

export type PromptMove = {
  state: PromptHistoryState
  text?: string
  cursor?: number
  apply: boolean
}

export function promptCopy(prompt: RunPrompt): RunPrompt {
  return {
    text: prompt.text,
    parts: structuredClone(prompt.parts),
  }
}

export function promptSame(a: RunPrompt, b: RunPrompt): boolean {
  return a.text === b.text && JSON.stringify(a.parts) === JSON.stringify(b.parts)
}

function mapInputBindings(binding: string, action: "submit" | "newline"): KeyBinding[] {
  return Keybind.parse(binding).map((item) => ({
    name: item.name,
    ctrl: item.ctrl || undefined,
    meta: item.meta || undefined,
    shift: item.shift || undefined,
    super: item.super || undefined,
    action,
  }))
}

function textareaBindings(keybinds: FooterKeybinds): KeyBinding[] {
  return [
    { name: "return", action: "submit" },
    { name: "return", meta: true, action: "newline" },
    ...mapInputBindings(keybinds.inputSubmit, "submit"),
    ...mapInputBindings(keybinds.inputNewline, "newline"),
  ]
}

export function promptKeys(keybinds: FooterKeybinds): PromptKeys {
  return {
    leaders: Keybind.parse(keybinds.leader),
    cycles: Keybind.parse(keybinds.variantCycle),
    interrupts: Keybind.parse(keybinds.interrupt),
    previous: Keybind.parse(keybinds.historyPrevious),
    next: Keybind.parse(keybinds.historyNext),
    bindings: textareaBindings(keybinds),
  }
}

export function printableBinding(binding: string, leader: string): string {
  const first = Keybind.parse(binding).at(0)
  if (!first) {
    return ""
  }

  let text = Keybind.toString(first)
  const lead = Keybind.parse(leader).at(0)
  if (lead) {
    text = text.replace("<leader>", Keybind.toString(lead))
  }

  return text.replace(/escape/g, "esc")
}

export function isExitCommand(input: string): boolean {
  const text = input.trim().toLowerCase()
  return text === "/exit" || text === "/quit" || text === ":q"
}

export function promptInfo(event: {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}): Keybind.Info {
  return {
    name: event.name === " " ? "space" : event.name,
    ctrl: !!event.ctrl,
    meta: !!event.meta,
    shift: !!event.shift,
    super: !!event.super,
    leader: false,
  }
}

export function promptHit(bindings: Keybind.Info[], event: Keybind.Info): boolean {
  return bindings.some((item) => Keybind.match(item, event))
}

export function promptCycle(
  armed: boolean,
  event: Keybind.Info,
  leaders: Keybind.Info[],
  cycles: Keybind.Info[],
): PromptCycle {
  if (!armed && promptHit(leaders, event)) {
    return {
      arm: true,
      clear: false,
      cycle: false,
      consume: true,
    }
  }

  if (armed) {
    return {
      arm: false,
      clear: true,
      cycle: promptHit(cycles, { ...event, leader: true }),
      consume: true,
    }
  }

  if (!promptHit(cycles, event)) {
    return {
      arm: false,
      clear: false,
      cycle: false,
      consume: false,
    }
  }

  return {
    arm: false,
    clear: false,
    cycle: true,
    consume: true,
  }
}

export function createPromptHistory(items?: RunPrompt[]): PromptHistoryState {
  const list = (items ?? []).filter((item) => item.text.trim().length > 0).map(promptCopy)
  const next: RunPrompt[] = []
  for (const item of list) {
    if (next.length > 0 && promptSame(next[next.length - 1], item)) {
      continue
    }

    next.push(item)
  }

  return {
    items: next.slice(-HISTORY_LIMIT),
    index: null,
    draft: "",
  }
}

export function pushPromptHistory(state: PromptHistoryState, prompt: RunPrompt): PromptHistoryState {
  if (!prompt.text.trim()) {
    return state
  }

  const next = promptCopy(prompt)
  if (state.items[state.items.length - 1] && promptSame(state.items[state.items.length - 1], next)) {
    return {
      ...state,
      index: null,
      draft: "",
    }
  }

  const items = [...state.items, next].slice(-HISTORY_LIMIT)
  return {
    ...state,
    items,
    index: null,
    draft: "",
  }
}

export function movePromptHistory(state: PromptHistoryState, dir: -1 | 1, text: string, cursor: number): PromptMove {
  if (state.items.length === 0) {
    return { state, apply: false }
  }

  if (dir === -1 && cursor !== 0) {
    return { state, apply: false }
  }

  if (dir === 1 && cursor !== text.length) {
    return { state, apply: false }
  }

  if (state.index === null) {
    if (dir === 1) {
      return { state, apply: false }
    }

    const idx = state.items.length - 1
    return {
      state: {
        ...state,
        index: idx,
        draft: text,
      },
      text: state.items[idx].text,
      cursor: 0,
      apply: true,
    }
  }

  const idx = state.index + dir
  if (idx < 0) {
    return { state, apply: false }
  }

  if (idx >= state.items.length) {
    return {
      state: {
        ...state,
        index: null,
      },
      text: state.draft,
      cursor: state.draft.length,
      apply: true,
    }
  }

  return {
    state: {
      ...state,
      index: idx,
    },
    text: state.items[idx].text,
    cursor: dir === -1 ? 0 : state.items[idx].text.length,
    apply: true,
  }
}
