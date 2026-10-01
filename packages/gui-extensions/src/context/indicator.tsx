import { Show, createMemo, type ComponentProps } from "solid-js"
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

  const message = createMemo(() => {
    const messages = props.session.id ? props.session.server.data.session.message.list(props.session.id) : []
    const last = messages.findLast((item) => item.type === "assistant" && !!item.tokens)

    return last?.type === "assistant" ? last : undefined
  })

  const model = createMemo(() => {
    const last = message()

    return last ? catalogModel(props.session, last.model)?.model : undefined
  })

  const info = createMemo(() =>
    props.session.id ? props.session.server.data.session.get(props.session.id) : undefined,
  )

  return (
    <Show when={props.session.id}>
      <ContextUsage
        tokens={message()?.tokens}
        contextLimit={model()?.limit.context}
        cost={info()?.cost}
        labels={{
          cost: ctx.t("usage.cost"),
          usage: ctx.t("usage.usage"),
          tokens: ctx.t("usage.tokens"),
          view: ctx.t("usage.view"),
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
