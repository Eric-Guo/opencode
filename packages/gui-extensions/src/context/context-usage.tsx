import { Show, createMemo, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Button } from "@opencode/ui/button"
import { Tooltip } from "@opencode/ui/tooltip"
import { useI18n } from "@opencode/ui/context/i18n"
import type { SessionMessageInfo } from "@opencode/client/promise"

function ContextTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

/** Shared usage display; the caller supplies session data and localized labels. */
export function ContextUsage(props: {
  tokens?: Extract<SessionMessageInfo, { type: "assistant" }>["tokens"]
  contextLimit?: number
  cost?: number
  showCost?: boolean
  expanded?: boolean
  labels: { cost: string; usage: string; tokens: string; view: string }
  class?: string
  variant?: "button" | "indicator"
  placement?: ComponentProps<typeof Tooltip>["placement"]
  onClick?: () => void
}) {
  const i18n = useI18n()
  const variant = createMemo(() => props.variant ?? "button")

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const context = createMemo(() => {
    const tokens = props.tokens

    if (!tokens) return
    const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

    return {
      total,
      usage: props.contextLimit ? Math.round((total / props.contextLimit) * 100) : null,
    }
  })

  const tokens = createMemo(() =>
    new Intl.NumberFormat(i18n.locale(), { notation: "compact", maximumFractionDigits: 0 })
      .format(context()?.total ?? 0)
      .toLocaleLowerCase(i18n.locale()),
  )

  const cost = createMemo(() => {
    return usd().format(props.cost ?? 0)
  })

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        appearance="indicator"
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={{
          "--progress-circle-background": "var(--v2-background-bg-layer-04, var(--border-weak-base))",
          "--progress-circle-background-overlay": "var(--v2-overlay-simple-overlay-pressed, transparent)",
          "--progress-circle-progress": "var(--v2-icon-icon-base, var(--icon-base))",
        }}
      />
    </div>
  )

  const compactCircle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle appearance="compact" size={16} percentage={context()?.usage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div class="flex w-[120px] flex-col gap-2">
      <Show when={props.showCost ?? true}>
        <ContextTooltipRow name={props.labels.cost} value={cost()} />
      </Show>
      <ContextTooltipRow name={props.labels.usage} value={`${context()?.usage ?? 0}%`} />
      <ContextTooltipRow name={props.labels.tokens} value={context()?.total.toLocaleString(i18n.locale()) ?? "0"} />
    </div>
  )

  return (
    <Tooltip
      value={variant() === "indicator" ? tooltipValue() : props.labels.view}
      class={props.class}
      placement={props.placement ?? "top"}
      triggerTabIndex={variant() === "indicator" ? 0 : undefined}
    >
      <Show
        when={variant() === "indicator"}
        fallback={
          <Button
            type="button"
            variant="ghost-muted"
            class="group shrink-0"
            style={{ padding: "0 6px", color: "var(--v2-text-text-faint)" }}
            onClick={props.onClick}
            aria-expanded={props.expanded}
            aria-label={props.labels.view}
          >
            <span class="flex items-center gap-2 whitespace-nowrap group-active:text-v2-text-text-muted">
              {compactCircle()}
              <span>{tokens()}</span>
              <Show when={props.showCost ?? true}>
                <span aria-hidden="true" class="flex w-1.5 shrink-0 items-center justify-center">
                  ·
                </span>
                <span>{cost()}</span>
              </Show>
            </span>
          </Button>
        }
      >
        {circle()}
      </Show>
    </Tooltip>
  )
}
