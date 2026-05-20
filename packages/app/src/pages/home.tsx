import type { Session } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Avatar as AvatarV2 } from "@opencode-ai/ui/v2/components/avatar-v2.jsx"
import { ButtonV2 } from "@opencode-ai/ui/v2/components/button-v2.jsx"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@opencode-ai/ui/v2/components/icon-button-v2.jsx"
import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
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
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { displayName, sortedRootSessions } from "@/pages/layout/helpers"
import { getProjectAvatarSource } from "@/pages/layout/sidebar-items"
import { getFilename } from "@opencode-ai/core/util/path"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"

const USE_HOME_DESIGN = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
const HOME_SESSION_LIMIT = 15

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export default function Home() {
  if (USE_HOME_DESIGN) return <HomeDesign />
  return <LegacyHome />
}

function HomeDesign() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const [state, setState] = createStore({ search: "" })

  const projects = createMemo(() => layout.projects.list())
  const projectDirectories = createMemo(() => projects().flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])]))
  const search = createMemo(() => state.search.trim())
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", ...projectDirectories()] as const,
    queryFn: async () => {
      await Promise.all(projectDirectories().map((directory) => sync.project.loadSessions(directory)))
      return null
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const records = createMemo(() =>
    [
      ...new Map(
        projectDirectories()
          .flatMap((directory) => sortedRootSessions(sync.child(directory, { bootstrap: false })[0], Date.now()))
          .map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
      ).values(),
    ]
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .flatMap((session) => {
        const project = projectForSession(session, projects(), projectByID())
        if (!project) return []
        return {
          session,
          project,
          projectName: displayName(project),
        }
      })
      .filter((record) => {
        const value = search().toLowerCase()
        if (!value) return true
        return `${record.session.title} ${record.projectName}`.toLowerCase().includes(value)
      })
      .slice(0, HOME_SESSION_LIMIT),
  )
  const groups = createMemo(() => groupSessions(records(), language))

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  function openNewSession() {
    const project = projects()[0]
    if (!project) {
      void chooseProject()
      return
    }
    layout.projects.open(project.worktree)
    server.projects.touch(project.worktree)
    navigate(`/${base64Encode(project.worktree)}/session`)
  }

  function openSession(session: Session) {
    const project = projectForSession(session, projects(), projectByID())
    layout.projects.open(project?.worktree ?? session.directory)
    server.projects.touch(project?.worktree ?? session.directory)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        result.forEach(openProject)
        return
      }
      if (result) openProject(result)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
      return
    }

    dialog.show(
      () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  function openSettings() {
    void import("@/components/dialog-settings").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  return (
    <div data-component="home-design" class="size-full overflow-y-auto bg-background-base">
      <div data-component="home-design-layout">
        <HomeProjectColumn
          projects={projects()}
          openProject={openProject}
          chooseProject={() => void chooseProject()}
          openSettings={openSettings}
          openHelp={() => platform.openLink("https://opencode.ai/desktop-feedback")}
          language={language}
        />

        <section data-component="home-sessions-column" aria-label={language.t("sidebar.project.recentSessions")}>
          <HomeSessionSearch
            value={state.search}
            placeholder={language.t("home.sessions.search.placeholder")}
            onInput={(value) => setState("search", value)}
          />
          <div data-component="home-session-groups">
            <Show
              when={!sessionLoad.isLoading}
              fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}
            >
              <Show
                when={groups().length > 0}
                fallback={
                  <div data-component="home-session-group">
                    <HomeSessionGroupHeader title={language.t("home.sessions.empty")} onNewSession={openNewSession} />
                  </div>
                }
              >
                <For each={groups()}>
                  {(group, index) => (
                    <div data-component="home-session-group">
                      <HomeSessionGroupHeader title={group.title} onNewSession={index() === 0 ? openNewSession : undefined} />
                      <div data-component="home-session-list">
                        <For each={group.sessions}>
                          {(record) => <HomeSessionRow record={record} openSession={openSession} />}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </section>
      </div>
    </div>
  )
}

function HomeProjectColumn(props: {
  projects: LocalProject[]
  openProject: (directory: string) => void
  chooseProject: () => void
  openSettings: () => void
  openHelp: () => void
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <aside data-component="home-project-column" aria-label={props.language.t("home.projects")}>
      <div data-component="home-project-header">
        <div data-component="home-section-label">{props.language.t("home.projects")}</div>
        <IconButtonV2
          data-action="home-add-project"
          variant="ghost-muted"
          size="large"
          class="titlebar-icon"
          onClick={props.chooseProject}
          aria-label={props.language.t("home.project.add")}
        >
          <IconV2 name="folder-add-left" />
        </IconButtonV2>
      </div>
      <div data-component="home-project-list">
        <Show
          when={props.projects.length > 0}
          fallback={
            <button type="button" data-component="home-nav-row" onClick={props.chooseProject}>
              <IconV2 name="folder-add-left" size="small" />
              <span>{props.language.t("home.project.add")}</span>
            </button>
          }
        >
          <For each={props.projects}>
            {(project) => (
              <button type="button" data-component="home-project-row" onClick={() => props.openProject(project.worktree)}>
                <HomeProjectAvatar project={project} />
                <span>{displayName(project)}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
      <div data-component="home-project-footer">
        <button type="button" data-component="home-nav-row" onClick={props.openSettings}>
          <IconV2 name="settings-gear" size="small" />
          <span>{props.language.t("sidebar.settings")}</span>
        </button>
        <button type="button" data-component="home-nav-row" onClick={props.openHelp}>
          <IconV2 name="help" size="small" />
          <span>{props.language.t("sidebar.help")}</span>
        </button>
      </div>
    </aside>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <AvatarV2
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      kind="org"
      size="small"
      {...getAvatarColors(props.project.icon?.color)}
      class="size-4 rounded"
    />
  )
}

function HomeSessionSearch(props: { value: string; placeholder: string; onInput: (value: string) => void }) {
  return (
    <label data-component="home-search">
      <IconV2 name="magnifying-glass" size="small" />
      <input
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  )
}

function HomeSessionGroupHeader(props: { title: string; onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div data-component="home-session-group-header">
      <div data-component="home-section-label">{props.title}</div>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2
            data-action="home-new-session"
            variant="ghost"
            size="normal"
            icon="edit"
            class="h-7 px-2"
            onClick={onNewSession()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionRow(props: { record: HomeSessionRecord; openSession: (session: Session) => void }) {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const [sessionStore] = globalSync.child(props.record.session.directory, { bootstrap: false })
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const unseenCount = createMemo(() => notification.session.unseenCount(props.record.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.record.session.id))
  const hasPermissions = createMemo(
    () =>
      !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.record.session.id, (item) => {
        return !permission.autoResponds(item, props.record.session.directory)
      }),
  )
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionStore.session_working(props.record.session.id)
  })
  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.record.session.id], sessionStore.agent))
  const showStatus = createMemo(() => isWorking() || hasPermissions() || hasError() || unseenCount() > 0)

  return (
    <button
      type="button"
      data-component="home-session-row"
      classList={{ "has-project": !!props.record.projectName }}
      onClick={() => props.openSession(props.record.session)}
    >
      <Show when={showStatus()}>
        <div data-component="home-session-status" style={{ color: tint() ?? "var(--icon-interactive-base)" }}>
          <Switch>
            <Match when={isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={hasPermissions()}>
              <div data-component="home-session-status-dot" class="bg-surface-warning-strong" />
            </Match>
            <Match when={hasError()}>
              <div data-component="home-session-status-dot" class="bg-text-diff-delete-base" />
            </Match>
            <Match when={unseenCount() > 0}>
              <div data-component="home-session-status-dot" class="bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <span data-component="home-session-title">{title()}</span>
      <Show when={props.record.projectName}>
        <span data-component="home-session-project">{props.record.projectName}</span>
      </Show>
    </button>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div data-component="home-session-group">
      <div data-component="home-session-group-header">
        <div data-component="home-section-label">{props.label}</div>
      </div>
      <div data-component="home-session-list" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div data-component="home-session-skeleton" />}</For>
      </div>
    </div>
  )
}

function projectForSession(session: Session, projects: LocalProject[], byID: Map<string, LocalProject>) {
  const direct = byID.get(session.projectID)
  if (direct) return direct
  const directory = pathKey(session.directory)
  return projects.find(
    (project) =>
      pathKey(project.worktree) === directory ||
      project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

function LegacyHome() {
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
        <Match when={recent().length > 0}>
          <div class="w-full flex flex-col items-center gap-6">
            <div class="text-20-medium text-text-strong text-center">{language.t("session.new.title")}</div>

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

              <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-border-weak-base">
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={toggleAgent}
                >
                  <Icon name="sliders" size="small" class="shrink-0" />
                  <span>Agent: {selectedAgent()}</span>
                </Button>

                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={handleModelSelect}
                >
                  <Icon name="brain" size="small" class="shrink-0" />
                  <span>Model: {activeModelName()}</span>
                </Button>

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

        <Match when={true}>
          <div class="w-full flex flex-col items-center gap-6">
            <div class="text-20-medium text-text-strong text-center">{language.t("home.empty.title")}</div>

            <div class="w-full bg-surface-base border border-border-base rounded-xl p-4 flex flex-col gap-3 shadow-md">
              <div class="text-14-regular text-text-weak w-full min-h-[4rem] cursor-pointer" onClick={chooseProject}>
                Ask anything, / for commands, @ for context...
              </div>

              <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-border-weak-base">
                <Button
                  size="small"
                  variant="ghost"
                  class="text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 px-2.5 py-1 bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-weak-base rounded-md"
                  onClick={chooseProject}
                >
                  <Icon name="folder" size="small" class="shrink-0" />
                  <span>Open project</span>
                </Button>

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
