// RunFooter -- the mutable control surface for direct interactive mode.
//
// In the split-footer architecture, scrollback is immutable (append-only)
// and the footer is the only region that can repaint. RunFooter owns both
// sides of that boundary:
//
//   Scrollback: append() queues StreamCommit entries and flush() writes them
//   to the renderer via writeToScrollback(). Commits coalesce in a microtask
//   queue -- consecutive progress chunks for the same part merge into one
//   write to avoid excessive scrollback snapshots.
//
//   Footer: event() updates the SolidJS signal-backed FooterState, which
//   drives the reactive footer view (prompt, status, permission, question).
//   present() swaps the active footer view and resizes the footer region.
//
// Lifecycle:
//   - close() flushes pending commits and notifies listeners (the prompt
//     queue uses this to know when to stop).
//   - destroy() does the same plus tears down event listeners and clears
//     internal state.
//   - The renderer's DESTROY event triggers destroy() so the footer
//     doesn't outlive the renderer.
//
// Interrupt and exit use a two-press pattern: first press shows a hint,
// second press within 5 seconds actually fires the action.
import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { PROMPT_MAX_ROWS, TEXTAREA_MIN_ROWS } from "./footer.prompt"
import { printableBinding } from "./prompt.shared"
import { RunFooterView } from "./footer.view"
import { normalizeEntry } from "./scrollback.format"
import { entryWriter } from "./scrollback"
import { spacerWriter } from "./scrollback.writer"
import { toolView } from "./tool"
import type { RunTheme } from "./theme"
import type {
  RunAgent,
  FooterApi,
  FooterEvent,
  FooterKeybinds,
  FooterPatch,
  RunPrompt,
  RunResource,
  FooterState,
  FooterView,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunDiffStyle,
  StreamCommit,
} from "./types"

type CycleResult = {
  modelLabel?: string
  status?: string
}

type RunFooterOptions = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  resources: RunResource[]
  agentLabel: string
  modelLabel: string
  first: boolean
  history?: RunPrompt[]
  theme: RunTheme
  keybinds: FooterKeybinds
  diffStyle: RunDiffStyle
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onInterrupt?: () => void
  onExit?: () => void
}

const PERMISSION_ROWS = 12
const QUESTION_ROWS = 14

export class RunFooter implements FooterApi {
  private closed = false
  private destroyed = false
  private prompts = new Set<(input: RunPrompt) => void>()
  private closes = new Set<() => void>()
  // Most recent visible scrollback commit.
  private tail: StreamCommit | undefined
  // The entry splash is already in scrollback before footer output starts.
  private wrote = true
  // Microtask-coalesced commit queue. Flushed on next microtask or on close/destroy.
  private queue: StreamCommit[] = []
  private pending = false
  // Fixed portion of footer height above the textarea.
  private base: number
  private rows = TEXTAREA_MIN_ROWS
  private state: Accessor<FooterState>
  private setState: Setter<FooterState>
  private view: Accessor<FooterView>
  private setView: Setter<FooterView>
  private interruptTimeout: NodeJS.Timeout | undefined
  private exitTimeout: NodeJS.Timeout | undefined
  private interruptHint: string

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: options.modelLabel,
      duration: "",
      usage: "",
      first: options.first,
      interrupt: 0,
      exit: 0,
    })
    this.state = state
    this.setState = setState
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })
    this.view = view
    this.setView = setView
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)
    this.interruptHint = printableBinding(options.keybinds.interrupt, options.keybinds.leader) || "esc"

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)

    void render(
      () =>
        createComponent(RunFooterView, {
          directory: options.directory,
          state: this.state,
          view: this.view,
          findFiles: options.findFiles,
          agents: () => options.agents,
          resources: () => options.resources,
          theme: options.theme.footer,
          block: options.theme.block,
          diffStyle: options.diffStyle,
          keybinds: options.keybinds,
          history: options.history,
          agent: options.agentLabel,
          onSubmit: this.handlePrompt,
          onPermissionReply: this.handlePermissionReply,
          onQuestionReply: this.handleQuestionReply,
          onQuestionReject: this.handleQuestionReject,
          onCycle: this.handleCycle,
          onInterrupt: this.handleInterrupt,
          onExitRequest: this.handleExit,
          onExit: () => this.close(),
          onRows: this.syncRows,
          onStatus: this.setStatus,
        }),
      this.renderer as unknown as Parameters<typeof render>[1],
    ).catch(() => {
      if (!this.destroyed && !this.renderer.isDestroyed) {
        this.close()
      }
    })
  }

  public get isClosed(): boolean {
    return this.closed || this.destroyed || this.renderer.isDestroyed
  }

  public onPrompt(fn: (input: RunPrompt) => void): () => void {
    this.prompts.add(fn)
    return () => {
      this.prompts.delete(fn)
    }
  }

  public onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn()
      return () => {}
    }

    this.closes.add(fn)
    return () => {
      this.closes.delete(fn)
    }
  }

  public event(next: FooterEvent): void {
    if (next.type === "queue") {
      this.patch({ queue: next.queue })
      return
    }

    if (next.type === "first") {
      this.patch({ first: next.first })
      return
    }

    if (next.type === "model") {
      this.patch({ model: next.model })
      return
    }

    if (next.type === "turn.send") {
      this.patch({
        phase: "running",
        status: "sending prompt",
        queue: next.queue,
      })
      return
    }

    if (next.type === "turn.wait") {
      this.patch({
        phase: "running",
        status: "waiting for assistant",
      })
      return
    }

    if (next.type === "turn.idle") {
      this.patch({
        phase: "idle",
        status: "",
        queue: next.queue,
      })
      return
    }

    if (next.type === "turn.duration") {
      this.patch({ duration: next.duration })
      return
    }

    if (next.type === "stream.patch") {
      if (typeof next.patch.status === "string" && next.patch.phase === undefined) {
        this.patch({ phase: "running", ...next.patch })
        return
      }

      this.patch(next.patch)
      return
    }

    this.present(next.view)
  }

  private patch(next: FooterPatch): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const prev = this.state()
    const state = {
      phase: next.phase ?? prev.phase,
      status: typeof next.status === "string" ? next.status : prev.status,
      queue: typeof next.queue === "number" ? Math.max(0, next.queue) : prev.queue,
      model: typeof next.model === "string" ? next.model : prev.model,
      duration: typeof next.duration === "string" ? next.duration : prev.duration,
      usage: typeof next.usage === "string" ? next.usage : prev.usage,
      first: typeof next.first === "boolean" ? next.first : prev.first,
      interrupt:
        typeof next.interrupt === "number" && Number.isFinite(next.interrupt)
          ? Math.max(0, Math.floor(next.interrupt))
          : prev.interrupt,
      exit:
        typeof next.exit === "number" && Number.isFinite(next.exit) ? Math.max(0, Math.floor(next.exit)) : prev.exit,
    }

    if (state.phase === "idle") {
      state.interrupt = 0
    }

    this.setState(state)

    if (prev.phase === "running" && state.phase === "idle") {
      this.flush()
    }
  }

  private present(view: FooterView): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    this.setView(view)
    this.applyHeight()
  }

  // Queues a scrollback commit. Consecutive progress chunks for the same
  // part coalesce by appending text, reducing the number of renderer writes.
  // Actual flush happens on the next microtask, so a burst of events from
  // one reducer pass becomes a single scrollback write.
  public append(commit: StreamCommit): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    if (!normalizeEntry(commit)) {
      return
    }

    const last = this.queue.at(-1)
    if (
      last &&
      last.phase === "progress" &&
      commit.phase === "progress" &&
      last.kind === commit.kind &&
      last.source === commit.source &&
      last.partID === commit.partID &&
      last.tool === commit.tool
    ) {
      last.text += commit.text
    } else {
      this.queue.push(commit)
    }

    if (this.pending) {
      return
    }

    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      this.flush()
    })
  }

  public idle(): Promise<void> {
    if (this.destroyed || this.renderer.isDestroyed) {
      return Promise.resolve()
    }

    return this.renderer.idle().catch(() => {})
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.flush()
    this.notifyClose()
  }

  public requestExit(): boolean {
    return this.handleExit()
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
    this.tail = undefined
    this.wrote = false
  }

  private notifyClose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const fn of [...this.closes]) {
      fn()
    }
  }

  private setStatus = (status: string): void => {
    this.patch({ status })
  }

  // Resizes the footer to fit the current view. Permission and question views
  // get fixed extra rows; the prompt view scales with textarea line count.
  private applyHeight(): void {
    const type = this.view().type
    const height =
      type === "permission"
        ? this.base + PERMISSION_ROWS
        : type === "question"
          ? this.base + QUESTION_ROWS
          : Math.max(this.base + TEXTAREA_MIN_ROWS, Math.min(this.base + PROMPT_MAX_ROWS, this.base + this.rows))

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height
    }
  }

  private syncRows = (value: number): void => {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(PROMPT_MAX_ROWS, value))
    if (rows === this.rows) {
      return
    }

    this.rows = rows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private handlePrompt = (input: RunPrompt): boolean => {
    if (this.isClosed) {
      return false
    }

    if (this.state().first) {
      this.patch({ first: false })
    }

    if (this.prompts.size === 0) {
      this.patch({ status: "input queue unavailable" })
      return false
    }

    for (const fn of [...this.prompts]) {
      fn(input)
    }

    return true
  }

  private handlePermissionReply = async (input: PermissionReply): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onPermissionReply(input)
  }

  private handleQuestionReply = async (input: QuestionReply): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onQuestionReply(input)
  }

  private handleQuestionReject = async (input: QuestionReject): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onQuestionReject(input)
  }

  private handleCycle = (): void => {
    const result = this.options.onCycleVariant?.()
    if (!result) {
      this.patch({ status: "no variants available" })
      return
    }

    const patch: FooterPatch = {
      status: result.status ?? "variant updated",
    }

    if (result.modelLabel) {
      patch.model = result.modelLabel
    }

    this.patch(patch)
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimeout) {
      return
    }

    clearTimeout(this.interruptTimeout)
    this.interruptTimeout = undefined
  }

  private armInterruptTimer(): void {
    this.clearInterruptTimer()
    this.interruptTimeout = setTimeout(() => {
      this.interruptTimeout = undefined
      if (this.destroyed || this.renderer.isDestroyed || this.state().phase !== "running") {
        return
      }

      this.patch({ interrupt: 0 })
    }, 5000)
  }

  private clearExitTimer(): void {
    if (!this.exitTimeout) {
      return
    }

    clearTimeout(this.exitTimeout)
    this.exitTimeout = undefined
  }

  private armExitTimer(): void {
    this.clearExitTimer()
    this.exitTimeout = setTimeout(() => {
      this.exitTimeout = undefined
      if (this.destroyed || this.renderer.isDestroyed || this.isClosed) {
        return
      }

      this.patch({ exit: 0 })
    }, 5000)
  }

  // Two-press interrupt: first press shows a hint ("esc again to interrupt"),
  // second press within 5 seconds fires onInterrupt. The timer resets the
  // counter if the user doesn't follow through.
  private handleInterrupt = (): boolean => {
    if (this.isClosed || this.state().phase !== "running") {
      return false
    }

    const next = this.state().interrupt + 1
    this.patch({ interrupt: next })

    if (next < 2) {
      this.armInterruptTimer()
      this.patch({ status: `${this.interruptHint} again to interrupt` })
      return true
    }

    this.clearInterruptTimer()
    this.patch({ interrupt: 0, status: "interrupting" })
    this.options.onInterrupt?.()
    return true
  }

  private handleExit = (): boolean => {
    if (this.isClosed) {
      return true
    }

    this.clearInterruptTimer()
    const next = this.state().exit + 1
    this.patch({ exit: next, interrupt: 0 })

    if (next < 2) {
      this.armExitTimer()
      this.patch({ status: "Press Ctrl-c again to exit" })
      return true
    }

    this.clearExitTimer()
    this.patch({ exit: 0, status: "exiting" })
    this.close()
    this.options.onExit?.()
    return true
  }

  private handleDestroy = (): void => {
    if (this.destroyed) {
      return
    }

    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
    this.tail = undefined
    this.wrote = false
  }

  // Drains the commit queue to scrollback. Visible commits start a new block
  // whenever their block key changes, and new blocks get a single spacer.
  private flush(): void {
    if (this.destroyed || this.renderer.isDestroyed || this.queue.length === 0) {
      this.queue.length = 0
      return
    }

    for (const item of this.queue.splice(0)) {
      const same = sameGroup(this.tail, item)
      if (this.wrote && !same) {
        this.renderer.writeToScrollback(spacerWriter())
      }

      this.renderer.writeToScrollback(entryWriter(item, this.options.theme, { diffStyle: this.options.diffStyle }))
      this.wrote = true
      this.tail = item
    }
  }
}

function snap(commit: StreamCommit): boolean {
  const tool = commit.tool ?? commit.part?.tool
  return (
    commit.kind === "tool" &&
    commit.phase === "final" &&
    (commit.toolState ?? commit.part?.state.status) === "completed" &&
    typeof tool === "string" &&
    Boolean(toolView(tool).snap)
  )
}

function groupKey(commit: StreamCommit): string | undefined {
  if (!commit.partID) {
    return
  }

  if (snap(commit)) {
    return `tool:${commit.partID}:final`
  }

  return `${commit.kind}:${commit.partID}`
}

function sameGroup(a: StreamCommit | undefined, b: StreamCommit): boolean {
  if (!a) {
    return false
  }

  const left = groupKey(a)
  const right = groupKey(b)
  if (left && right && left === right) {
    return true
  }

  return a.kind === "tool" && a.phase === "start" && b.kind === "tool" && b.phase === "start"
}
