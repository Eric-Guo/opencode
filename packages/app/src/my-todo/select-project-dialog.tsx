import { MyTodo } from "@opencode/schema/my-todo"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import { For, Show, type JSX } from "solid-js"

export function SelectProjectDialog(props: {
  children?: JSX.Element
  projects: readonly MyTodo.Project[]
  value?: number
  busy?: boolean
  onSelect: (project: MyTodo.Project) => void
}) {
  const language = useLanguage()

  return (
    <Dialog
      fit
      containerClass="!h-auto max-h-[calc(100vh_-_16px)] !w-[min(calc(100vw_-_16px),640px)]"
      class="[font-family:var(--v2-font-family-sans)] [&_[data-slot=dialog-header]]:!px-5 [&_[data-slot=dialog-header-title]]:!text-[15px] [&_[data-slot=dialog-header-title]]:!tracking-[-0.13px]"
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("myTodo.selectProject")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[calc(100vh_-_68px)] min-h-0 flex-none gap-0 overflow-y-auto px-2 pb-2">
        <div class="flex min-h-0 flex-col">
          {props.children}
          <For each={props.projects}>
            {(project) => (
              <button
                type="button"
                class="flex w-full scroll-my-3.5 flex-row items-center gap-1.5 rounded-md px-3 py-2 text-left text-[13px] font-[530] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:var(--v2-font-family-sans)] [font-variation-settings:'slnt'_0] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                disabled={props.busy}
                onClick={() => props.onSelect(project)}
              >
                <span class="min-w-0 truncate">{project.project_name}</span>
                <Show when={props.value === project.work_package_id}>
                  <Icon name="check" class="ml-auto size-4 shrink-0 text-v2-icon-icon-base" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </DialogBody>
    </Dialog>
  )
}
