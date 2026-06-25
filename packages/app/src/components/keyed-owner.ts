import { createComponent, type JSX, Show } from "solid-js"

export function KeyedOwner<T>(props: {
  value: T | undefined
  children: (value: T) => JSX.Element
}) {
  return createComponent<{
    when: T | undefined
    keyed: true
    children: (value: T) => JSX.Element
  }>(Show, {
    get when() {
      return props.value
    },
    keyed: true,
    get children() {
      return props.children
    },
  })
}
