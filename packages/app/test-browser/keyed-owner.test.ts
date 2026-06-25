import { expect, test } from "bun:test"
import { createComponent, createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { KeyedOwner } from "@/components/keyed-owner"

test("replaces and disposes ownership when the key changes", () => {
  const host = document.createElement("div")
  const [directory, setDirectory] = createSignal<string>()
  const lifecycle: string[] = []
  const dispose = render(
    () =>
      createComponent(KeyedOwner<string>, {
        get value() {
          return directory()
        },
        children(value) {
          lifecycle.push(`mount:${value}`)
          onCleanup(() => lifecycle.push(`dispose:${value}`))
          const element = document.createElement("span")
          element.textContent = value
          return element
        },
      }),
    host,
  )

  expect(host.textContent).toBe("")
  setDirectory("D1")
  expect(host.textContent).toBe("D1")
  expect(lifecycle).toEqual(["mount:D1"])

  setDirectory("D2")
  expect(host.textContent).toBe("D2")
  expect(lifecycle).toEqual(["mount:D1", "dispose:D1", "mount:D2"])

  setDirectory()
  expect(host.textContent).toBe("")
  expect(lifecycle).toEqual(["mount:D1", "dispose:D1", "mount:D2", "dispose:D2"])

  setDirectory("D3")
  dispose()
  expect(lifecycle).toEqual(["mount:D1", "dispose:D1", "mount:D2", "dispose:D2", "mount:D3", "dispose:D3"])
})
