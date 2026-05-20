import { Show, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"
import { Logo } from "@opencode-ai/ui/logo"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
const ROOT_CLASS = "size-full flex flex-col items-center justify-center"

interface NewSessionViewProps {
  worktree: string
}

export function NewSessionView(props: NewSessionViewProps) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()

  const sandboxes = createMemo(() => sync.project?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => {
    const selection = props.worktree
    if (options().includes(selection)) return selection
    return MAIN_WORKTREE
  })
  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const isWorktree = createMemo(() => {
    const project = sync.project
    if (!project) return false
    return sdk.directory !== project.worktree
  })

  const label = (value: string) => {
    if (value === MAIN_WORKTREE) {
      if (isWorktree()) return language.t("session.new.worktree.main")
      const branch = sync.data.vcs?.branch
      if (branch) return branch
      return language.t("session.new.worktree.main")
    }

    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")

    return getFilename(value)
  }

  return (
    <div class={ROOT_CLASS}>
      <div class="w-full max-w-xl flex flex-col items-center justify-center text-center gap-8 px-6 py-12">
        {/* Figma aligned centered Logo & Title */}
        <div class="flex flex-col items-center gap-6">
          <Logo class="w-48 opacity-85 hover:opacity-100 transition-opacity duration-200" />
          <div class="text-28-medium text-text-strong font-semibold tracking-tight">
            {language.t("session.new.title")}
          </div>
        </div>

        {/* Project Meta Cards */}
        <div class="w-full flex flex-col gap-3 items-center justify-center text-13-regular text-text-weak">
          <div class="flex items-center gap-2 px-3 py-1.5 bg-surface-base border border-border-weak-base rounded-md shadow-sm">
            <Icon name="folder" size="small" class="shrink-0 text-text-weak" />
            <span class="select-text truncate max-w-sm">
              {getDirectory(projectRoot())}
              <span class="text-text-strong font-medium">{getFilename(projectRoot())}</span>
            </span>
          </div>

          <div class="flex items-center gap-2 px-3 py-1.5 bg-surface-base border border-border-weak-base rounded-md shadow-sm">
            <Icon name="branch" size="small" class="shrink-0 text-text-weak" />
            <span class="select-text font-mono truncate max-w-xs">{label(current())}</span>
          </div>

          <Show when={sync.project}>
            {(project) => (
              <div class="text-11-regular text-text-weak mt-1">
                {language.t("session.new.lastModified")}{" "}
                <span class="text-text-strong font-medium">
                  {DateTime.fromMillis(project().time.updated ?? project().time.created)
                    .setLocale(language.intl())
                    .toRelative()}
                </span>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
