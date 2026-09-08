import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createMemoryComposerState } from "@/composer/state"
import { createComposerEditor } from "@/composer/editor/interaction"

test("the editor disables send and keyboard submission until the project has a work package", () => {
  createRoot((dispose) => {
    const [selection, setSelection] = createStore({ workPackageID: undefined as number | undefined })
    const calls: (boolean | undefined)[] = []
    const editor = createComposerEditor({
      store: createMemoryComposerState({ prompt: "hello" }).store,
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      view: {
        submit: {
          enabled: () => !!selection.workPackageID,
          stopping: () => false,
          onSubmit: (options) => {
            calls.push(options?.alternate)
          },
          onStop() {},
        },
      },
    })
    expect(editor.canSubmit()).toBe(false)
    editor.submit()
    editor.submit({ alternate: true })
    expect(calls).toEqual([])
    setSelection("workPackageID", 42)
    expect(editor.canSubmit()).toBe(true)
    editor.submit()
    expect(calls).toEqual([undefined])
    setSelection("workPackageID", undefined)
    expect(editor.canSubmit()).toBe(false)
    editor.submit()
    expect(calls).toEqual([undefined])
    dispose()
  })
})
