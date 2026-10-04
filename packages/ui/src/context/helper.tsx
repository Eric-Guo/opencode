import { createContext, createMemo, Show, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T, Props extends object>(
  input: {
    name: string
    init: (input: Props) => T
  } & (T extends { ready: unknown } ? { gate: boolean } : { gate?: boolean }),
) {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const gate = input.gate ?? true

      if (!gate) {
        return <ctx.Provider value={init}>{props.children}</ctx.Provider>
      }

      // Access init.ready inside the memo to make it reactive for getter properties
      const isReady = createMemo(() => {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Generic contexts also accept primitive values, which have no readiness gate.
        if ((typeof init !== "object" && typeof init !== "function") || !init || !("ready" in init)) return true
        const ready = init.ready

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Context readiness may be a Solid accessor or a boolean; the generic init owns this contract.
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
