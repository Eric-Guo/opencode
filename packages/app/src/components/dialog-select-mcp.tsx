import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { Component, createMemo, onMount, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()
  const mcpQuery = useQuery(() => queryOptions.mcp(pathKey(sdk.directory)))

  onMount(() => {
    void queryClient.fetchQuery(queryOptions.mcp(pathKey(sdk.directory)))
  })

  const mcpStatus = () => mcpQuery.data ?? {}

  const items = createMemo(() =>
    [
      ...new Set([
        ...Object.entries(sync.data.config.mcp ?? {})
          .filter((entry) => typeof entry[1] === "object" && entry[1] !== null && "type" in entry[1])
          .map(([name]) => name),
        ...Object.keys(mcpStatus()),
      ]),
    ]
      .map((name) => ({ name, status: mcpStatus()[name]?.status ?? "disabled" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = mcpStatus()[name]
      if (status?.status === "connected") {
        await sdk.client.mcp.disconnect({ name, directory: sdk.directory })
        return sdk.client.mcp.status({ directory: sdk.directory }).then((r) => r.data ?? {})
      }
      if (status?.status === "needs_auth") {
        await sdk.client.mcp.auth.authenticate({ name, directory: sdk.directory })
        return sdk.client.mcp.status({ directory: sdk.directory }).then((r) => r.data ?? {})
      }
      await sdk.client.mcp.connect({ name, directory: sdk.directory })
      return sdk.client.mcp.status({ directory: sdk.directory }).then((r) => r.data ?? {})
    },
    onSuccess: (data) => queryClient.setQueryData(queryOptions.mcp(pathKey(sdk.directory)).queryKey, data),
  }))

  const enabledCount = createMemo(() => items().filter((i) => i.status === "connected").length)
  const totalCount = createMemo(() => items().length)

  return (
    <Dialog
      title={language.t("dialog.mcp.title")}
      description={language.t("dialog.mcp.description", { enabled: enabledCount(), total: totalCount() })}
    >
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.mcp.empty")}
        key={(x) => x?.name ?? ""}
        items={items}
        filterKeys={["name", "status"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (!x || toggle.isPending) return
          toggle.mutate(x.name)
        }}
      >
        {(i) => {
          const itemStatus = () => mcpStatus()[i.name]
          const status = () => itemStatus()?.status
          const statusLabel = () => {
            const key = status() ? statusLabels[status() as keyof typeof statusLabels] : undefined
            if (!key) return
            return language.t(key)
          }
          const error = () => {
            const s = itemStatus()
            if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
          }
          const enabled = () => status() === "connected"
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate">{i.name}</span>
                  <Show when={statusLabel()}>
                    <span class="text-11-regular text-text-weaker">{statusLabel()}</span>
                  </Show>
                </div>
                <Show when={error()}>
                  <span class="text-11-regular text-text-weaker truncate">{error()}</span>
                </Show>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={enabled()}
                  onChange={() => {
                    if (toggle.isPending) return
                    toggle.mutate(i.name)
                  }}
                />
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
