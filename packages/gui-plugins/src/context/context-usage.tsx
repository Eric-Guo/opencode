import { Show, createMemo, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Button } from "@opencode/ui/button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { useI18n } from "@opencode/ui/context/i18n"
import type { SessionMessageInfo } from "@opencode/client/promise"

/** Shared usage display; the caller supplies session data and localized labels. */
export function ContextUsage(props: {
  tokens?: Extract<SessionMessageInfo, { type: "assistant" }>["tokens"]
  contextLimit?: number
  cost?: number
  showCost?: boolean
  allowance?: { amount: number; label: string; format: (amount: string) => string }
  expanded?: boolean
  labels: { cost: string; usage: string; tokens: string; view: string; open?: string }
  class?: string
  variant?: "button" | "indicator"
  placement?: ComponentProps<typeof Tooltip>["placement"]
  /** Show only the ring, with details and the view action in a menu. */
  compact?: boolean
  onView?: () => void
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

  const allowance = createMemo(() => {
    const value = props.allowance

    return value && value.amount > 0 ? value : undefined
  })

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        appearance="indicator"
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={{
          "--progress-circle-background": "var(--v2-background-bg-layer-04)",
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

  const menuRow = (name: JSX.Element, value: JSX.Element) => (
    <div class="flex h-7 min-w-0 items-center gap-4 px-3 text-[13px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px]">
      <span class="shrink-0 text-v2-text-text-muted">{name}</span>
      <span class="ml-auto min-w-0 truncate text-right tabular-nums text-v2-text-text-base">{value}</span>
    </div>
  )

  const usageMenu = () => (
    <Menu placement="bottom-end" gutter={4} modal={false}>
      <Tooltip value={props.labels.open ?? props.labels.view} placement={props.placement ?? "top"}>
        <Menu.Trigger
          as={Button}
          type="button"
          variant="ghost-muted"
          class="group shrink-0"
          style={{ padding: "0 6px", color: "var(--v2-text-text-faint)" }}
          aria-label={props.labels.open ?? props.labels.view}
        >
          {compactCircle()}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content class="w-[200px] max-w-[calc(100vw-16px)]" aria-label={props.labels.open ?? props.labels.view}>
          {menuRow(props.labels.tokens, context()?.total.toLocaleString(i18n.locale()) ?? "0")}
          <Show when={props.showCost ?? true}>{menuRow(props.labels.cost, cost())}</Show>
          <Show when={allowance()}>{(value) => menuRow(value().label, usd().format(value().amount))}</Show>
          {menuRow(props.labels.usage, `${context()?.usage ?? 0}%`)}
          <Menu.Separator />
          <Menu.Item onSelect={props.onView ?? props.onClick}>{props.labels.open ?? props.labels.view}</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )

  return (
    <Show when={!props.compact} fallback={usageMenu()}>
      <Show
        when={variant() === "indicator"}
        fallback={
          <Tooltip value={props.labels.view} class={props.class} placement={props.placement ?? "top"}>
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
                <Show when={allowance()}>
                  {(value) => (
                    <>
                      <span aria-hidden="true" class="flex w-1.5 shrink-0 items-center justify-center">
                        ·
                      </span>
                      <span>{value().format(usd().format(value().amount))}</span>
                    </>
                  )}
                </Show>
              </span>
            </Button>
          </Tooltip>
        }
      >
        {circle()}
      </Show>
    </Show>
  )
}
