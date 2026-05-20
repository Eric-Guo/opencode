import { createMemo, For, Match, Switch, createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogSelectModel } from "@/components/dialog-select-model"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/core/util/path"

export default function Home() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()

  const [promptText, setPromptText] = createSignal("")
  const [selectedAgent, setSelectedAgent] = createSignal("frontend-specialist")
  const [showProjectsDropdown, setShowProjectsDropdown] = createSignal(false)

  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const currentProject = createMemo(() => recent()[0]?.worktree)

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory)
        }
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  function handleModelSelect() {
    dialog.show(() => <DialogSelectModel />)
  }

  function toggleAgent() {
    const agents = ["frontend-specialist", "build", "general"]
    const nextIndex = (agents.indexOf(selectedAgent()) + 1) % agents.length
    setSelectedAgent(agents[nextIndex])
  }

  function handleSubmit() {
    const projectToOpen = currentProject()
    if (projectToOpen) {
      openProject(projectToOpen)
    } else {
      chooseProject()
    }
  }

  const activeModelName = createMemo(() => {
    const model = sync.data.config.model
    if (!model) return "GPT-5.7 Pro"
    const parts = model.split("/")
    return parts[parts.length - 1]
  })

  return (
    <div class="mx-auto mt-24 w-full max-w-2xl px-6 flex flex-col items-center">
      {/* Top logo & server selector */}
      <div class="flex flex-col items-center gap-3 mb-10">
        <div onClick={chooseProject} class="cursor-pointer hover:opacity-25 transition-opacity duration-200">
          <Logo class="w-48 opacity-15" />
        </div>
        <Button
          size="normal"
          variant="ghost"
          class="text-12-regular text-text-weak px-3"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
        >
          <div
            classList={{
              "size-1.5 rounded-full mr-2": true,
              [serverDotClass()]: true,
            }}
          />
          {server.name}
        </Button>
      </div>

      <Switch>
        {/* CASE B: NEW SESSION (User has configured projects) */}
        <Match when={recent().length > 0}>
          <div class="w-full flex flex-col items-center gap-6">
            <div class="text-20-medium text-text-strong text-center">
              {language.t("session.new.title")}
            </div>

            {/* Central Styled Input Box */}
            <div class="w-full bg-surface-base border border-border-base rounded-xl p-4 flex flex-col gap-3 shadow-md relative">
              <textarea
                class="bg-transparent border-none outline-none text-14-regular text-text-base placeholder-text-weak w-full resize-none h-20 focus:outline-none"
                placeholder="Ask anything, / for commands, @ for context..."
                value={promptText()}
                onInput={(e) => setPromptText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
              />

              {/* Figma Dropdowns/Triggers Row */}
              <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-border-weak-base">
                {/* Agent Trigger */}
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={toggleAgent}
                >
                  <Icon name="sliders" size="small" class="shrink-0" />
                  <span>Agent: {selectedAgent()}</span>
                </Button>

                {/* Model Trigger */}
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={handleModelSelect}
                >
                  <Icon name="brain" size="small" class="shrink-0" />
                  <span>Model: {activeModelName()}</span>
                </Button>

                {/* Project Trigger */}
                <div class="relative">
                  <Button
                    size="small"
                    variant="ghost"
                    class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                    onClick={() => setShowProjectsDropdown(!showProjectsDropdown())}
                  >
                    <Icon name="folder" size="small" class="shrink-0" />
                    <span>Project: {currentProject() ? getFilename(currentProject()) : "Select Project"}</span>
                  </Button>

                  <Show when={showProjectsDropdown()}>
                    <div class="absolute left-0 mt-1 w-64 bg-surface-raised-base border border-border-base rounded-lg p-2 shadow-lg z-50 flex flex-col gap-1">
                      <div class="text-10-semibold text-text-weak px-2 py-1 uppercase tracking-wider">
                        {language.t("home.recentProjects")}
                      </div>
                      <For each={recent()}>
                        {(project) => (
                          <button
                            class="text-12-mono text-left px-2 py-1.5 hover:bg-surface-raised-base-hover rounded flex items-center justify-between w-full"
                            onClick={() => {
                              openProject(project.worktree)
                              setShowProjectsDropdown(false)
                            }}
                          >
                            <span class="truncate">{getFilename(project.worktree)}</span>
                            <span class="text-10-regular text-text-weak shrink-0 pl-2">
                              {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                            </span>
                          </button>
                        )}
                      </For>
                      <div class="border-t border-border-weak-base my-1" />
                      <button
                        class="text-12-medium text-text-strong text-left px-2 py-1.5 hover:bg-surface-raised-base-hover rounded flex items-center gap-2 w-full"
                        onClick={() => {
                          setShowProjectsDropdown(false)
                          chooseProject()
                        }}
                      >
                        <Icon name="folder-add-left" size="small" />
                        {language.t("command.project.open")}
                      </button>
                    </div>
                  </Show>
                </div>

                {/* Branch Trigger */}
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base border border-border-weak-base rounded-md cursor-default pointer-events-none"
                >
                  <Icon name="branch" size="small" class="shrink-0" />
                  <span>Branch: dev</span>
                </Button>
              </div>
            </div>
          </div>
        </Match>

        {/* CASE A: FIRST USE (User has no projects yet) */}
        <Match when={true}>
          <div class="w-full flex flex-col items-center gap-6">
            <div class="text-20-medium text-text-strong text-center">
              {language.t("home.empty.title")}
            </div>

            {/* Central Styled Input Box */}
            <div class="w-full bg-surface-base border border-border-base rounded-xl p-4 flex flex-col gap-3 shadow-md">
              <div
                class="text-14-regular text-text-weak w-full min-h-[4rem] cursor-pointer"
                onClick={chooseProject}
              >
                Ask anything, / for commands, @ for context...
              </div>

              {/* Bottom Row Actions */}
              <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-border-weak-base">
                {/* Open Folder Action */}
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={chooseProject}
                >
                  <Icon name="folder" size="small" class="shrink-0" />
                  <span>Open project</span>
                </Button>

                {/* Model Selector Action */}
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={handleModelSelect}
                >
                  <Icon name="brain" size="small" class="shrink-0" />
                  <span>Model: {activeModelName()}</span>
                </Button>
              </div>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
