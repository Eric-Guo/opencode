import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@/utils/toast"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogWslServer } from "@/components/dialog-wsl-server"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useWslServers } from "@/context/wsl-servers"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"
import { useSettings } from "@/context/settings"

const DEFAULT_USERNAME = "opencode"

interface ServerFormProps {
  value: string
  name: string
  username: string
  password: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onNameChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function isWslSidecar(conn: ServerConnection.Any): conn is ServerConnection.Sidecar & { variant: "wsl" } {
  return conn.type === "sidecar" && conn.variant === "wsl"
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultActions] = createResource(
    async () => {
      try {
        return (await platform.getDefaultServer?.()) ?? null
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )
  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }
  return { defaultKey: () => defaultKey.latest, canDefault, setDefault }
}

function useServerPreview() {
  const checkServerHealth = useCheckServerHealth()

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (
    value: string,
    username: string,
    password: string,
    setStatus: (value: boolean | undefined) => void,
  ) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const http: ServerConnection.HttpBase = { url: normalized }
    if (username) http.username = username
    if (password) http.password = password
    const result = await checkServerHealth(http)
    setStatus(result.healthy)
  }

  return { previewStatus }
}

function ServerForm(props: ServerFormProps) {
  const language = useLanguage()
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      props.onBack()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    props.onSubmit()
  }

  return (
    <div>
      <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
        <div class="flex-1 min-w-0 [&_[data-slot=input-wrapper]]:relative">
          <TextField
            type="text"
            label={language.t("dialog.server.add.url")}
            placeholder={props.placeholder}
            value={props.value}
            autofocus
            validationState={props.error ? "invalid" : "valid"}
            error={props.error}
            disabled={props.busy}
            onChange={props.onChange}
            onKeyDown={keyDown}
          />
        </div>
        <TextField
          type="text"
          label={language.t("dialog.server.add.name")}
          placeholder={language.t("dialog.server.add.namePlaceholder")}
          value={props.name}
          disabled={props.busy}
          onChange={props.onNameChange}
          onKeyDown={keyDown}
        />
        <div class="grid grid-cols-2 gap-2 min-w-0">
          <TextField
            type="text"
            label={language.t("dialog.server.add.username")}
            placeholder={language.t("dialog.server.add.usernamePlaceholder")}
            value={props.username}
            disabled={props.busy}
            onChange={props.onUsernameChange}
            onKeyDown={keyDown}
          />
          <TextField
            type="password"
            label={language.t("dialog.server.add.password")}
            placeholder={language.t("dialog.server.add.passwordPlaceholder")}
            value={props.password}
            disabled={props.busy}
            onChange={props.onPasswordChange}
            onKeyDown={keyDown}
          />
        </div>
      </div>
    </div>
  )
}

export function DialogSelectServer() {
  const dialog = useDialog()
  const controller = useServerManagementController({ onSelect: dialog.close })

  return (
    <Dialog
      title={controller.formTitle()}
      fit={controller.isAddWslMode()}
      class={
        controller.isAddWslMode()
          ? "[&_[data-slot=dialog-body]]:flex-none [&_[data-slot=dialog-body]]:overflow-visible"
          : undefined
      }
    >
      <div class={controller.isAddWslMode() ? "flex flex-col gap-2 px-5" : "flex flex-1 min-h-0 flex-col px-5"}>
        <Show when={!controller.isAddWslMode()} fallback={<DialogWslServer onAdded={controller.handleAddedWsl} />}>
          <Show when={controller.isFormMode()} fallback={<ServerConnectionList controller={controller} />}>
            <ServerConnectionForm controller={controller} />
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}

export function useServerManagementController(options: { onSelect?: () => void } = {}) {
  const navigate = useNavigate()
  const server = useServer()
  const global = useGlobal()
  const platform = usePlatform()
  const language = useLanguage()
  const wslServers = useWslServers()
  const { defaultKey, canDefault, setDefault } = useDefaultServer()
  const { previewStatus } = useServerPreview()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    addServer: {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    addWsl: {
      showWizard: false,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined as boolean | undefined,
    },
  })

  const resetAdd = () => {
    setStore("addServer", {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined,
    })
  }
  const resetEdit = () => {
    setStore("editServer", {
      id: undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined,
    })
  }

  const addMutation = useMutation(() => ({
    mutationFn: async (value: string) => {
      const normalized = normalizeServerUrl(value)
      if (!normalized) {
        resetAdd()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (store.addServer.name.trim()) conn.displayName = store.addServer.name.trim()
      if (store.addServer.password) conn.http.password = store.addServer.password
      if (store.addServer.password && store.addServer.username) conn.http.username = store.addServer.username
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("addServer", { error: language.t("dialog.server.add.error") })
        return
      }

      resetAdd()
      await select(conn, true)
    },
  }))

  const editMutation = useMutation(() => ({
    mutationFn: async (input: { original: ServerConnection.Any; value: string }) => {
      if (input.original.type !== "http") return
      const normalized = normalizeServerUrl(input.value)
      if (!normalized) {
        resetEdit()
        return
      }

      const name = store.editServer.name.trim() || undefined
      const username = store.editServer.username || undefined
      const password = store.editServer.password || undefined
      const existingName = input.original.displayName
      if (
        normalized === input.original.http.url &&
        name === existingName &&
        username === input.original.http.username &&
        password === input.original.http.password
      ) {
        resetEdit()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        displayName: name,
        http: { url: normalized, username, password },
      }
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("editServer", { error: language.t("dialog.server.add.error") })
        return
      }
      if (normalized === input.original.http.url) {
        server.add(conn)
      } else {
        replaceServer(input.original, conn)
      }

      resetEdit()
    },
  }))

  const removeWslMutation = useMutation(() => ({
    mutationFn: async (key: ServerConnection.Key) => {
      await platform.wslServers?.removeServer(key)
      return key
    },
    onSuccess: async (key) => {
      if (defaultKey() === key) await setDefault(null)
      server.remove(key)
    },
    onError: (err) => showRequestError(language, err),
  }))

  const retryWslMutation = useMutation(() => ({
    mutationFn: async (key: ServerConnection.Key) => {
      await platform.wslServers?.startServer(key)
    },
    onError: (err) => showRequestError(language, err),
  }))

  const updateWslMutation = useMutation(() => ({
    mutationFn: async (distro: string) => {
      await platform.wslServers?.installOpencode(distro)
    },
    onError: (err) => showRequestError(language, err),
  }))

  const replaceServer = (original: ServerConnection.Http, next: ServerConnection.Http) => {
    const active = server.key
    const newConn = server.add(next)
    if (!newConn) return
    const nextActive = active === ServerConnection.key(original) ? ServerConnection.key(newConn) : active
    if (nextActive) server.setActive(nextActive)
    server.remove(ServerConnection.key(original))
  }

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const settings = useSettings()
  const current = createMemo<ServerConnection.Any | undefined>(() =>
    settings.general.newLayoutDesigns()
      ? undefined
      : (items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0]),
  )
  const wslState = () => wslServers.data
  const wslRuntime = (conn: ServerConnection.Any) => {
    if (!isWslSidecar(conn)) return
    return wslState()?.servers.find((item) => item.config.id === ServerConnection.key(conn))?.runtime
  }
  const nonReadyWslServers = createMemo(() =>
    (wslState()?.servers ?? []).filter((item) => item.runtime.kind !== "ready"),
  )
  const canRetryWsl = (conn: ServerConnection.Any) => {
    const runtime = wslRuntime(conn)
    return runtime?.kind === "failed" || runtime?.kind === "stopped"
  }
  const canRetryWslRuntime = (kind: string) => kind === "failed" || kind === "stopped"
  const wslRuntimeLabel = (kind: string) => {
    if (kind === "starting") return "Starting"
    if (kind === "failed") return "Failed"
    return "Stopped"
  }
  const wslCheck = (conn: ServerConnection.Any) => {
    if (!isWslSidecar(conn)) return null
    return wslState()?.opencodeChecks[conn.distro] ?? null
  }

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff =
        rank(global.servers.health[ServerConnection.key(a)]) - rank(global.servers.health[ServerConnection.key(b)])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function select(conn: ServerConnection.Any, persist?: boolean) {
    if (!persist && global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    options.onSelect?.()
    if (persist && conn.type === "http") {
      server.add(conn)
      navigate("/")
      return
    }
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(conn)))
  }

  const handleAddChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { url: value, error: "" })
    void previewStatus(value, store.addServer.username, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddNameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { name: value, error: "" })
  }

  const handleAddUsernameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { username: value, error: "" })
    void previewStatus(store.addServer.url, value, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddPasswordChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { password: value, error: "" })
    void previewStatus(store.addServer.url, store.addServer.username, value, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleEditChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { value, error: "" })
    void previewStatus(value, store.editServer.username, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditNameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { name: value, error: "" })
  }

  const handleEditUsernameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { username: value, error: "" })
    void previewStatus(store.editServer.value, value, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditPasswordChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { password: value, error: "" })
    void previewStatus(store.editServer.value, store.editServer.username, value, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const mode = createMemo<"list" | "add-wsl" | "add" | "edit">(() => {
    if (store.addWsl.showWizard) return "add-wsl"
    if (store.editServer.id) return "edit"
    if (store.addServer.showForm) return "add"
    return "list"
  })

  const editing = createMemo(() => {
    if (!store.editServer.id) return
    return items().find((x) => x.type === "http" && x.http.url === store.editServer.id)
  })

  const resetForm = () => {
    resetAdd()
    resetEdit()
    setStore("addWsl", "showWizard", false)
  }

  const startAdd = () => {
    setStore("addWsl", "showWizard", false)
    resetEdit()
    setStore("addServer", {
      showForm: true,
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      status: undefined,
    })
  }

  const startEdit = (conn: ServerConnection.Http) => {
    setStore("addWsl", "showWizard", false)
    resetAdd()
    setStore("editServer", {
      id: conn.http.url,
      value: conn.http.url,
      name: conn.displayName ?? "",
      username: conn.http.username ?? "",
      password: conn.http.password ?? "",
      error: "",
      status: global.servers.health[ServerConnection.key(conn)]?.healthy,
    })
  }

  const startAddWsl = () => {
    resetAdd()
    resetEdit()
    setStore("addWsl", "showWizard", true)
  }

  const handleAddedWsl = async (distro: string) => {
    const key = ServerConnection.Key.make(`wsl:${distro}`)
    setStore("addWsl", "showWizard", false)
    const conn = items().find((item) => ServerConnection.key(item) === key)
    if (conn) await select(conn)
  }

  const submitForm = () => {
    if (mode() === "add") {
      if (addMutation.isPending) return
      setStore("addServer", { error: "" })
      addMutation.mutate(store.addServer.url)
      return
    }
    const original = editing()
    if (!original) return
    if (editMutation.isPending) return
    setStore("editServer", { error: "" })
    editMutation.mutate({ original, value: store.editServer.value })
  }

  const isFormMode = createMemo(() => mode() !== "list")
  const isAddMode = createMemo(() => mode() === "add")
  const isAddWslMode = createMemo(() => mode() === "add-wsl")
  const formBusy = createMemo(() => (isAddMode() ? addMutation.isPending : editMutation.isPending))
  const canAddWsl = createMemo(() => !!platform.wslServers && platform.os === "windows")

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.server.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton icon="arrow-left" variant="ghost" onClick={resetForm} aria-label={language.t("common.goBack")} />
        <span>
          {isAddWslMode()
            ? "Add WSL server"
            : isAddMode()
              ? language.t("dialog.server.add.title")
              : language.t("dialog.server.edit.title")}
        </span>
      </div>
    )
  })

  createEffect(() => {
    if (!store.editServer.id) return
    if (editing()) return
    resetEdit()
  })

  async function handleRemove(key: ServerConnection.Key) {
    server.remove(key)
    if (defaultKey() === key) await setDefault(null)
  }

  return {
    defaultKey,
    canDefault,
    current,
    sortedItems,
    status: () => global.servers.health,
    isFormMode,
    isAddMode,
    isAddWslMode,
    canAddWsl,
    nonReadyWslServers,
    canRetryWsl,
    canRetryWslRuntime,
    wslRuntimeLabel,
    wslCheck,
    wslJob: () => wslState()?.job,
    formTitle,
    formBusy,
    formValue: () => (isAddMode() ? store.addServer.url : store.editServer.value),
    formName: () => (isAddMode() ? store.addServer.name : store.editServer.name),
    formUsername: () => (isAddMode() ? store.addServer.username : store.editServer.username),
    formPassword: () => (isAddMode() ? store.addServer.password : store.editServer.password),
    formError: () => (isAddMode() ? store.addServer.error : store.editServer.error),
    formStatus: () => (isAddMode() ? store.addServer.status : store.editServer.status),
    select,
    setDefault,
    startAdd,
    startAddWsl,
    startEdit,
    resetForm,
    submitForm,
    handleRemove,
    handleAddedWsl,
    retryWsl: (key: ServerConnection.Key) => retryWslMutation.mutate(key),
    removeWsl: (key: ServerConnection.Key) => removeWslMutation.mutate(key),
    updateWsl: (distro: string) => updateWslMutation.mutate(distro),
    handleFormChange: () => (isAddMode() ? handleAddChange : handleEditChange),
    handleFormNameChange: () => (isAddMode() ? handleAddNameChange : handleEditNameChange),
    handleFormUsernameChange: () => (isAddMode() ? handleAddUsernameChange : handleEditUsernameChange),
    handleFormPasswordChange: () => (isAddMode() ? handleAddPasswordChange : handleEditPasswordChange),
  }
}

export function ServerConnectionList(props: { controller: ReturnType<typeof useServerManagementController> }) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex flex-1 min-h-0 flex-col gap-4">
      <Show when={props.controller.nonReadyWslServers().length > 0}>
        <div class="bg-surface-base rounded-md overflow-hidden">
          <For each={props.controller.nonReadyWslServers()}>
            {(item) => {
              const key = ServerConnection.Key.make(item.config.id)
              const retryable = () => props.controller.canRetryWslRuntime(item.runtime.kind)
              return (
                <div class="min-h-14 p-3 flex items-center gap-3 border-b border-border-weak-base last:border-b-0">
                  <div
                    classList={{
                      "size-1.5 rounded-full shrink-0": true,
                      "bg-icon-critical-base": item.runtime.kind === "failed",
                      "bg-border-weak-base": item.runtime.kind !== "failed",
                    }}
                  />
                  <div class="flex items-center gap-2 min-w-0 flex-1">
                    <span class="text-14-medium text-text-base truncate">{item.config.distro}</span>
                    <span class="text-11-regular text-text-weak border border-border-weak-base bg-surface-base px-1.5 py-0.5 rounded-md shrink-0">
                      WSL
                    </span>
                    <Show when={props.controller.defaultKey() === key}>
                      <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs shrink-0">
                        {language.t("dialog.server.status.default")}
                      </span>
                    </Show>
                    <span class="text-12-regular text-text-weak truncate">
                      {props.controller.wslRuntimeLabel(item.runtime.kind)}
                    </span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <Show when={retryable()}>
                          <DropdownMenu.Item onSelect={() => props.controller.retryWsl(key)}>
                            <DropdownMenu.ItemLabel>Retry start</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() !== key}>
                          <DropdownMenu.Item onSelect={() => void props.controller.setDefault(key)}>
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                          <DropdownMenu.Item onSelect={() => void props.controller.setDefault(null)}>
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.defaultRemove")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={retryable() || props.controller.canDefault()}>
                          <DropdownMenu.Separator />
                        </Show>
                        <DropdownMenu.Item
                          onSelect={() => props.controller.removeWsl(key)}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
        search={{
          placeholder: language.t("dialog.server.search.placeholder"),
          autofocus: false,
        }}
        noInitialSelection
        emptyMessage={language.t("dialog.server.empty")}
        items={props.controller.sortedItems}
        key={(x) => ServerConnection.key(x)}
        onSelect={(x) => {
          if (x && !settings.general.newLayoutDesigns()) void props.controller.select(x)
        }}
        divider={true}
      >
        {(i) => {
          const key = ServerConnection.key(i)
          const wsl = isWslSidecar(i)
          const wslDistro = wsl ? i.distro : undefined
          const canChangeDefault = () => props.controller.canDefault() && (i.type === "http" || wsl)
          const canRemove = () => i.type === "http" || wsl
          const opencodeAction = () => {
            const check = props.controller.wslCheck(i)
            if (!check) return null
            if (!check.resolvedPath) return "Install OpenCode"
            if (check.matchesDesktop === false) return "Update OpenCode"
            return null
          }
          const updating = () => {
            const job = props.controller.wslJob()
            return job?.kind === "install-opencode" && job.distro === wslDistro
          }
          return (
            <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
              <div class="flex flex-col h-full items-center w-5">
                <ServerHealthIndicator health={props.controller.status()[key]} />
              </div>
              <ServerRow
                conn={i}
                dimmed={props.controller.status()[key]?.healthy === false}
                status={props.controller.status()[key]}
                version={props.controller.wslCheck(i)?.version ?? undefined}
                class="flex items-center gap-3 min-w-0 flex-1"
                badge={
                  <Show when={props.controller.defaultKey() === ServerConnection.key(i)}>
                    <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                      {language.t("dialog.server.status.default")}
                    </span>
                  </Show>
                }
                showCredentials
              />
              <div class="flex items-center justify-center gap-3 pl-4">
                <Show when={wsl && opencodeAction()}>
                  {(label) => (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!!props.controller.wslJob()}
                      class="shrink-0"
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation()
                        if (wslDistro) props.controller.updateWsl(wslDistro)
                      }}
                    >
                      <Show when={updating()}>
                        <Spinner class="size-3.5 shrink-0" />
                      </Show>
                      {label()}
                    </Button>
                  )}
                </Show>
                <Show when={props.controller.current()}>
                  {(current) => (
                    <Show when={ServerConnection.key(current()) === key}>
                      <Icon name="check" class="h-6" />
                    </Show>
                  )}
                </Show>

                <Show when={i.type === "http" || wsl}>
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <Show when={i.type === "http"}>
                          <DropdownMenu.Item
                            onSelect={() => {
                              if (i.type !== "http") return
                              props.controller.startEdit(i)
                            }}
                          >
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={wsl && props.controller.canRetryWsl(i)}>
                          <DropdownMenu.Item onSelect={() => props.controller.retryWsl(key)}>
                            <DropdownMenu.ItemLabel>Retry start</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={canChangeDefault() && props.controller.defaultKey() !== key}>
                          <DropdownMenu.Item onSelect={() => void props.controller.setDefault(key)}>
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={canChangeDefault() && props.controller.defaultKey() === key}>
                          <DropdownMenu.Item onSelect={() => void props.controller.setDefault(null)}>
                            <DropdownMenu.ItemLabel>
                              {language.t("dialog.server.menu.defaultRemove")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={canRemove() && (i.type === "http" || canChangeDefault() || props.controller.canRetryWsl(i))}>
                          <DropdownMenu.Separator />
                        </Show>
                        <Show when={canRemove()}>
                          <DropdownMenu.Item
                            onSelect={() => {
                              if (wsl) {
                                props.controller.removeWsl(key)
                                return
                              }
                              void props.controller.handleRemove(key)
                            }}
                            class="text-text-on-critical-base hover:bg-surface-critical-weak"
                          >
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Show>
              </div>
            </div>
          )
        }}
      </List>

      <div class="shrink-0 pb-5">
        <div class="flex items-center gap-2">
          <Button
            variant="secondary"
            icon="plus-small"
            size="large"
            onClick={props.controller.startAdd}
            class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
          >
            {language.t("dialog.server.add.button")}
          </Button>
          <Show when={props.controller.canAddWsl()}>
            <Button
              variant="secondary"
              icon="plus-small"
              size="large"
              onClick={props.controller.startAddWsl}
              class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
            >
              Add WSL
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}

export function ServerConnectionForm(props: { controller: ReturnType<typeof useServerManagementController> }) {
  const language = useLanguage()

  return (
    <div class="flex flex-1 min-h-0 flex-col gap-4">
      <ServerForm
        value={props.controller.formValue()}
        name={props.controller.formName()}
        username={props.controller.formUsername()}
        password={props.controller.formPassword()}
        placeholder={language.t("dialog.server.add.placeholder")}
        busy={props.controller.formBusy()}
        error={props.controller.formError()}
        status={props.controller.formStatus()}
        onChange={props.controller.handleFormChange()}
        onNameChange={props.controller.handleFormNameChange()}
        onUsernameChange={props.controller.handleFormUsernameChange()}
        onPasswordChange={props.controller.handleFormPasswordChange()}
        onSubmit={props.controller.submitForm}
        onBack={props.controller.resetForm}
      />
      <div class="shrink-0 pb-5">
        <Button
          variant="primary"
          size="large"
          onClick={props.controller.submitForm}
          disabled={props.controller.formBusy()}
          class="px-3 py-1.5"
        >
          {props.controller.formBusy()
            ? language.t("dialog.server.add.checking")
            : props.controller.isAddMode()
              ? language.t("dialog.server.add.button")
              : language.t("common.save")}
        </Button>
      </div>
    </div>
  )
}
