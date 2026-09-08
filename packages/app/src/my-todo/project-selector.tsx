import { MyTodo } from "@opencode/schema/my-todo"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerCtx } from "@/runtime/server/runtime"
import { createResource, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SelectProjectDialog } from "./select-project-dialog"

export function ProjectSelector(props: {
  server?: ServerCtx
  project?: { id?: string; myTodo?: MyTodo.Project }
  sidebar?: boolean
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const selected = () => props.project?.myTodo

  const open = () => {
    const server = props.server
    const projectID = props.project?.id
    if (!server || !projectID) return
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
        const saved = await server.sdk.api.project.update({ projectID, myTodo: project }).catch(() => {
          setStatus({ saving: false, saveFailed: true })
          return undefined
        })
        if (!saved) return
        server.data.project.invalidate()
        await server.data.project.sync().catch(() => undefined)
        dialog.close()
      }
      return (
        <SelectProjectDialog
          projects={projects() ?? []}
          value={selected()?.work_package_id}
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
    <Show when={props.server && props.project?.id}>
      <Button
        variant="ghost"
        onClick={open}
        class="h-7 min-w-0 max-w-48 shrink [app-region:no-drag]"
        classList={{ "mb-4 self-start": props.sidebar }}
        title={selected()?.project_name}
        aria-label={language.t("myTodo.selectProject")}
      >
        <span class="min-w-0 truncate">{selected()?.project_name ?? language.t("myTodo.selectProject")}</span>
      </Button>
    </Show>
  )
}
