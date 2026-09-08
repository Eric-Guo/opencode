import { MyTodo } from "@opencode/schema/my-todo"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerCtx } from "@/runtime/server/runtime"
import { createEffect, createResource, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SelectProjectDialog } from "./select-project-dialog"

export function ProjectSelector(props: { server?: ServerCtx; sidebar?: boolean }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore<{ selected: MyTodo.Project | null; failed: boolean }>({
    selected: null,
    failed: false,
  })

  createEffect(() => {
    const server = props.server
    setState({ selected: null, failed: false })
    if (!server) return
    let active = true
    const refresh = () => {
      void server.sdk.api.server.myTodoSelection().then(
        (selected) => {
          if (active) setState({ selected, failed: false })
        },
        () => {
          if (active) setState("failed", true)
        },
      )
    }
    refresh()
    window.addEventListener("focus", refresh)
    onCleanup(() => {
      active = false
      window.removeEventListener("focus", refresh)
    })
  })

  const open = () => {
    const server = props.server
    if (!server) return
    dialog.show(() => {
      const [status, setStatus] = createStore({ saving: false, loadFailed: false, saveFailed: false })
      const [projects] = createResource(async () =>
        server.sdk.api.server.myTodoProjects().catch(() => {
          setStatus("loadFailed", true)
          return []
        }),
      )
      const select = async (project: MyTodo.Project) => {
        setStatus({ saving: true, saveFailed: false })
        const saved = await server.sdk.api.server.selectMyTodo(project).catch(() => {
          setStatus({ saving: false, saveFailed: true })
          return undefined
        })
        if (!saved) return
        if (server === props.server) setState({ selected: saved, failed: false })
        dialog.close()
      }
      return (
        <SelectProjectDialog
          projects={projects() ?? []}
          value={state.selected?.work_package_id}
          busy={status.saving}
          onSelect={select}
        >
          <Show when={projects.loading || status.loadFailed || status.saveFailed || projects()?.length === 0}>
            <p class="px-3 py-2 text-[13px] leading-5 text-v2-text-text-muted" role="status">
              {status.saveFailed
                ? language.t("myTodo.saveFailed")
                : status.loadFailed
                  ? language.t("myTodo.loadFailed")
                  : projects.loading
                    ? language.t("common.loading")
                    : language.t("myTodo.empty")}
            </p>
          </Show>
        </SelectProjectDialog>
      )
    })
  }

  return (
    <Show when={props.server}>
      <Button
        variant="ghost"
        onClick={open}
        class="h-7 min-w-0 max-w-48 shrink [app-region:no-drag]"
        classList={{ "mb-4 self-start": props.sidebar }}
        title={state.selected?.project_name}
        aria-label={language.t("myTodo.selectProject")}
      >
        <span class="min-w-0 truncate">
          {state.selected?.project_name ?? language.t(state.failed ? "myTodo.loadFailed" : "myTodo.selectProject")}
        </span>
      </Button>
    </Show>
  )
}
