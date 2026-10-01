import { Show, createMemo, type ComponentProps } from "solid-js"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { useExtension, type MountedSession } from "../sdk"
import { catalogModel, syncCatalog } from "./catalog"
import { ContextUsage } from "./context-usage"

export function SessionContextUsage(props: {
  session: MountedSession
  variant?: ComponentProps<typeof ContextUsage>["variant"]
  placement?: ComponentProps<typeof ContextUsage>["placement"]
}) {
  const ctx = useExtension()
  const layout = ctx.layout

  syncCatalog(() => props.session)

  const messages = createMemo(() =>
    props.session.id ? props.session.server.data.session.message.list(props.session.id) : [],
  )

  const info = createMemo(() => (props.session.id ? props.session.server.data.session.get(props.session.id) : undefined))

  // Same step as the TUI: after the last completed compaction and before an undo boundary.
  const message = createMemo(() => lastAssistantWithUsage(messages(), info()?.revert?.messageID))

  const model = createMemo(() => {
    const last = message()

    return last ? catalogModel(props.session, last.model)?.model : undefined
  })

  // A root session's cost includes its subagent sessions, as in the TUI.
  const cost = createMemo(() => (props.session.id ? props.session.server.data.session.cost(props.session.id) : 0))

  // Spend anywhere in the family keeps the cost visible, even when this session's model is free.
  const showCost = createMemo(() => {
    if (cost() > 0) return true
    const ref = info()?.model ?? messages().findLast((item) => item.type === "assistant")?.model
    const model = ref ? catalogModel(props.session, ref)?.model : undefined

    if (!model) return true

    return model.cost.some((cost) => cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0)
  })

  return (
    <Show when={props.session.id}>
      <ContextUsage
        tokens={message()?.tokens}
        contextLimit={model()?.limit.context}
        cost={cost()}
        showCost={showCost()}
        expanded={layout.state(`${ctx.id}:main`, props.session) === "visible"}
        labels={{
          cost: ctx.t("usage.cost"),
          usage: ctx.t("usage.usage"),
          tokens: ctx.t("usage.tokens"),
          view: ctx.t("usage.toggle"),
        }}
        variant={props.variant}
        placement={props.placement}
        onClick={() => {
          if (props.session.id) layout.toggle(`${ctx.id}:main`, props.session)
        }}
      />
    </Show>
  )
}
