import { createContext, createMemo, Show, useContext, type ParentProps, type Accessor, type Context } from "solid-js"

type SimpleContextCache = Map<string, Context<unknown>>

function getContext<T>(name: string) {
  const scope = globalThis as typeof globalThis & {
    __OPENCODE_SIMPLE_CONTEXTS__?: SimpleContextCache
  }
  scope.__OPENCODE_SIMPLE_CONTEXTS__ ??= new Map()
  const cached = scope.__OPENCODE_SIMPLE_CONTEXTS__.get(name)
  if (cached) return cached as unknown as Context<T | undefined>
  const ctx = createContext<T>()
  scope.__OPENCODE_SIMPLE_CONTEXTS__.set(name, ctx as unknown as Context<unknown>)
  return ctx
}

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
  gate?: boolean
}) {
  const ctx = getContext<T>(input.name)

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const gate = input.gate ?? true

      if (!gate) {
        return <ctx.Provider value={init}>{props.children}</ctx.Provider>
      }

      // Access init.ready inside the memo to make it reactive for getter properties
      const isReady = createMemo(() => {
        // @ts-expect-error
        const ready = init.ready as Accessor<boolean> | boolean | undefined
        return ready === undefined || (typeof ready === "function" ? ready() : ready)
      })
      return (
        <Show when={isReady()}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
