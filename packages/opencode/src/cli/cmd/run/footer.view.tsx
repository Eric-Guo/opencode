// Top-level footer layout for direct interactive mode.
//
// Renders the footer region as a vertical stack:
//   1. Spacer row (visual separation from scrollback)
//   2. Composer frame with left-border accent -- swaps between prompt,
//      permission, and question bodies via Switch/Match
//   3. Meta row showing agent name and model label
//   4. Bottom border + status row (spinner, interrupt hint, duration, usage)
//
// All state comes from the parent RunFooter through SolidJS signals.
// The view itself is stateless except for derived memos.
/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid"
import { Match, Show, Switch, createMemo } from "solid-js"
import "opentui-spinner/solid"
import { createColors, createFrames } from "../tui/ui/spinner"
import { RunPromptAutocomplete, RunPromptBody, createPromptState, hintFlags } from "./footer.prompt"
import { RunPermissionBody } from "./footer.permission"
import { RunQuestionBody } from "./footer.question"
import { printableBinding } from "./prompt.shared"
import type {
  FooterKeybinds,
  RunAgent,
  RunPrompt,
  RunResource,
  FooterState,
  FooterView,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunDiffStyle,
} from "./types"
import { RUN_THEME_FALLBACK, type RunBlockTheme, type RunFooterTheme } from "./theme"

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

type RunFooterViewProps = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: () => RunAgent[]
  resources: () => RunResource[]
  state: () => FooterState
  view?: () => FooterView
  theme?: RunFooterTheme
  block?: RunBlockTheme
  diffStyle?: RunDiffStyle
  keybinds: FooterKeybinds
  history?: RunPrompt[]
  agent: string
  onSubmit: (input: RunPrompt) => boolean
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycle: () => void
  onInterrupt: () => boolean
  onExitRequest?: () => boolean
  onExit: () => void
  onRows: (rows: number) => void
  onStatus: (text: string) => void
}

export { TEXTAREA_MIN_ROWS, TEXTAREA_MAX_ROWS } from "./footer.prompt"

export function RunFooterView(props: RunFooterViewProps) {
  const term = useTerminalDimensions()
  const active = createMemo<FooterView>(() => props.view?.() ?? { type: "prompt" })
  const prompt = createMemo(() => active().type === "prompt")
  const variant = createMemo(() => printableBinding(props.keybinds.variantCycle, props.keybinds.leader))
  const interrupt = createMemo(() => printableBinding(props.keybinds.interrupt, props.keybinds.leader))
  const hints = createMemo(() => hintFlags(term().width))
  const busy = createMemo(() => props.state().phase === "running")
  const armed = createMemo(() => props.state().interrupt > 0)
  const exiting = createMemo(() => props.state().exit > 0)
  const queue = createMemo(() => props.state().queue)
  const duration = createMemo(() => props.state().duration)
  const usage = createMemo(() => props.state().usage)
  const interruptKey = createMemo(() => interrupt() || "/exit")
  const theme = createMemo(() => props.theme ?? RUN_THEME_FALLBACK.footer)
  const block = createMemo(() => props.block ?? RUN_THEME_FALLBACK.block)
  const spin = createMemo(() => {
    return {
      frames: createFrames({
        color: theme().highlight,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      color: createColors({
        color: theme().highlight,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    }
  })
  const permission = createMemo<Extract<FooterView, { type: "permission" }> | undefined>(() => {
    const view = active()
    return view.type === "permission" ? view : undefined
  })
  const question = createMemo<Extract<FooterView, { type: "question" }> | undefined>(() => {
    const view = active()
    return view.type === "question" ? view : undefined
  })
  const composer = createPromptState({
    directory: props.directory,
    findFiles: props.findFiles,
    agents: props.agents,
    resources: props.resources,
    keybinds: props.keybinds,
    state: props.state,
    view: () => active().type,
    prompt,
    width: () => term().width,
    theme,
    history: props.history,
    onSubmit: props.onSubmit,
    onCycle: props.onCycle,
    onInterrupt: props.onInterrupt,
    onExitRequest: props.onExitRequest,
    onExit: props.onExit,
    onRows: props.onRows,
    onStatus: props.onStatus,
  })
  const menu = createMemo(() => active().type === "prompt" && composer.visible())

  return (
    <box
      id="run-direct-footer-shell"
      width="100%"
      height="100%"
      border={false}
      backgroundColor="transparent"
      flexDirection="column"
      gap={0}
      padding={0}
    >
      <box id="run-direct-footer-top-spacer" width="100%" height={1} flexShrink={0} backgroundColor="transparent" />

      <box
        id="run-direct-footer-composer-frame"
        width="100%"
        flexShrink={0}
        border={["left"]}
        borderColor={theme().highlight}
        customBorderChars={{
          ...EMPTY_BORDER,
          vertical: "┃",
          bottomLeft: "╹",
        }}
      >
        <box
          id="run-direct-footer-composer-area"
          width="100%"
          flexGrow={1}
          paddingLeft={0}
          paddingRight={0}
          paddingTop={0}
          flexDirection="column"
          backgroundColor={theme().surface}
          gap={0}
        >
          <box id="run-direct-footer-body" width="100%" flexGrow={1} flexShrink={1} flexDirection="column">
            <Switch>
              <Match when={active().type === "prompt"}>
                <RunPromptBody
                  theme={theme}
                  placeholder={composer.placeholder}
                  bindings={composer.bindings}
                  onSubmit={composer.onSubmit}
                  onKeyDown={composer.onKeyDown}
                  onContentChange={composer.onContentChange}
                  bind={composer.bind}
                />
              </Match>
              <Match when={active().type === "permission"}>
                <RunPermissionBody
                  request={permission()!.request}
                  theme={theme()}
                  block={block()}
                  diffStyle={props.diffStyle}
                  onReply={props.onPermissionReply}
                />
              </Match>
              <Match when={active().type === "question"}>
                <RunQuestionBody
                  request={question()!.request}
                  theme={theme()}
                  onReply={props.onQuestionReply}
                  onReject={props.onQuestionReject}
                />
              </Match>
            </Switch>
          </box>

          <box
            id="run-direct-footer-meta-row"
            width="100%"
            flexDirection="row"
            gap={1}
            paddingLeft={2}
            flexShrink={0}
            paddingTop={1}
          >
            <text id="run-direct-footer-agent" fg={theme().highlight} wrapMode="none" truncate flexShrink={0}>
              {props.agent}
            </text>
            <text id="run-direct-footer-model" fg={theme().text} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
              {props.state().model}
            </text>
          </box>
        </box>
      </box>

      <box
        id="run-direct-footer-line-6"
        width="100%"
        height={1}
        border={["left"]}
        borderColor={theme().highlight}
        backgroundColor="transparent"
        customBorderChars={{
          ...EMPTY_BORDER,
          vertical: "╹",
        }}
        flexShrink={0}
      >
        <box
          id="run-direct-footer-line-6-fill"
          width="100%"
          height={1}
          border={["bottom"]}
          borderColor={theme().surface}
          backgroundColor={menu() ? theme().shade : "transparent"}
          customBorderChars={{
            ...EMPTY_BORDER,
            horizontal: "▀",
          }}
        />
      </box>

      <Show
        when={menu()}
        fallback={
          <box
            id="run-direct-footer-row"
            width="100%"
            height={1}
            flexDirection="row"
            justifyContent="space-between"
            gap={1}
            flexShrink={0}
          >
            <Show when={busy() || exiting()}>
              <box id="run-direct-footer-hint-left" flexDirection="row" gap={1} flexShrink={0}>
                <Show when={exiting()}>
                  <text id="run-direct-footer-hint-exit" fg={theme().highlight} wrapMode="none" truncate marginLeft={1}>
                    Press Ctrl-c again to exit
                  </text>
                </Show>

                <Show when={busy() && !exiting()}>
                  <box id="run-direct-footer-status-spinner" marginLeft={1} flexShrink={0}>
                    <spinner color={spin().color} frames={spin().frames} interval={40} />
                  </box>

                  <text
                    id="run-direct-footer-hint-interrupt"
                    fg={armed() ? theme().highlight : theme().text}
                    wrapMode="none"
                    truncate
                  >
                    {interruptKey()}{" "}
                    <span style={{ fg: armed() ? theme().highlight : theme().muted }}>
                      {armed() ? "again to interrupt" : "interrupt"}
                    </span>
                  </text>
                </Show>
              </box>
            </Show>

            <Show when={!busy() && !exiting() && duration().length > 0}>
              <box id="run-direct-footer-duration" flexDirection="row" gap={2} flexShrink={0} marginLeft={1}>
                <text id="run-direct-footer-duration-mark" fg={theme().muted} wrapMode="none" truncate>
                  ▣
                </text>
                <box id="run-direct-footer-duration-tail" flexDirection="row" gap={1} flexShrink={0}>
                  <text id="run-direct-footer-duration-dot" fg={theme().muted} wrapMode="none" truncate>
                    ·
                  </text>
                  <text id="run-direct-footer-duration-value" fg={theme().muted} wrapMode="none" truncate>
                    {duration()}
                  </text>
                </box>
              </box>
            </Show>

            <box id="run-direct-footer-spacer" flexGrow={1} flexShrink={1} backgroundColor="transparent" />

            <box id="run-direct-footer-hint-group" flexDirection="row" gap={2} flexShrink={0} justifyContent="flex-end">
              <Show when={queue() > 0}>
                <text id="run-direct-footer-queue" fg={theme().muted} wrapMode="none" truncate>
                  {queue()} queued
                </text>
              </Show>
              <Show when={usage().length > 0}>
                <text id="run-direct-footer-usage" fg={theme().muted} wrapMode="none" truncate>
                  {usage()}
                </text>
              </Show>
              <Show when={variant().length > 0 && hints().variant}>
                <text id="run-direct-footer-hint-variant" fg={theme().muted} wrapMode="none" truncate>
                  {variant()} variant
                </text>
              </Show>
            </box>
          </box>
        }
      >
        <RunPromptAutocomplete theme={theme} options={composer.options} selected={composer.selected} />
      </Show>
    </box>
  )
}
