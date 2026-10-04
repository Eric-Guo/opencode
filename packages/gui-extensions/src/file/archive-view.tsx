import { createMemo, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { createVirtualizer } from "@tanstack/solid-virtual"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { FileSystem } from "@opencode/schema/filesystem"
import { FileIcon } from "@opencode/ui/file-icon"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { getDirectory, getFilename } from "@opencode/util/path"
import { createLatest, useExtension, type FileContent, type MountedSession } from "../sdk"
import { archiveRows, archiveTree } from "./archive-tree"
import { formatBytes } from "./artifact"

type ArchiveRequest = { client: OpenCodeClient; path: string; directory: string; content: FileContent }

export default function ArchiveView(props: { session: MountedSession; path: string; content: FileContent }) {
  const request = createMemo(() => ({
    client: props.session.server.client,
    path: props.path,
    directory: props.session.directory,
    content: props.content,
  }))

  // One owner per file/server/revision: switching or closing aborts the request and drops its reply and UI state.
  return (
    <Show when={request()} keyed>
      {(input) => <ArchiveLoad input={input} />}
    </Show>
  )
}

function ArchiveLoad(props: { input: ArchiveRequest }) {
  const ctx = useExtension()
  const [state, setState] = createStore({ revision: 0 })

  const result = createLatest(
    () => state.revision,
    async (_, signal) => {
      const absolute = /^([a-z]:)?[\\/]/i.test(props.input.path)

      const response = await props.input.client.file.archive(
        {
          path: absolute ? getFilename(props.input.path) : props.input.path,
          location: { directory: absolute ? getDirectory(props.input.path) : props.input.directory },
        },
        { signal },
      )

      return response.data
    },
  )

  const ready = () => {
    const archive = result.latest

    return archive?.status === "ready" ? archive : undefined
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2 text-12-regular text-text-weak">
        <span class="min-w-0 truncate">{ctx.t("view.archive.readOnly")}</span>
        <Show when={result.latest}>
          {(archive) => <span class="shrink-0 tabular-nums">{formatBytes(ctx.locale.locale(), archive().size)}</span>}
        </Show>
      </div>
      <Switch>
        <Match when={result.loading}>
          <div role="status" class="p-4 text-13-regular text-text-weak">
            {ctx.t("view.archive.loading")}
          </div>
        </Match>
        <Match when={result.error !== undefined}>
          <div role="alert" class="flex flex-col items-start gap-3 p-4 text-13-regular text-text-weak">
            <span>{ctx.t("view.archive.requestFailed")}</span>
            <Button size="small" variant="outline" onClick={() => setState("revision", (value) => value + 1)}>
              {ctx.t("view.archive.retry")}
            </Button>
          </div>
        </Match>
        <Match when={result.latest}>
          {(archive) => (
            <Show
              when={ready()}
              keyed
              fallback={
                <div role="alert" class="p-4 text-13-regular text-text-weak">
                  {ctx.t(`view.archive.${archive().status}`)}
                </div>
              }
            >
              {(value) => <ArchiveDirectory archive={value} />}
            </Show>
          )}
        </Match>
      </Switch>
    </div>
  )
}

function ArchiveDirectory(props: { archive: Extract<FileSystem.Archive, { status: "ready" }> }) {
  const ctx = useExtension()
  const tree = createMemo(() => archiveTree(props.archive.entries))

  const [state, setState] = createStore<{ search: string; expanded: ReadonlySet<string>; viewport?: HTMLDivElement }>({
    search: "",
    expanded: new Set(),
  })

  const rows = createMemo(() => archiveRows(tree(), state.expanded, state.search))

  const virtual = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length
    },
    getScrollElement: () => state.viewport ?? null,
    initialRect: { width: 0, height: 600 },
    estimateSize: () => 32,
    overscan: 8,
    get getItemKey() {
      return (index: number) => rows()[index]?.node.id ?? index
    },
  })

  const toggle = (id: string) => {
    const next = new Set(state.expanded)

    if (next.has(id)) next.delete(id)
    else next.add(id)

    setState("expanded", next)
  }

  return (
    <>
      <div class="flex shrink-0 flex-wrap items-center gap-3 border-b border-v2-border-border-muted px-4 py-2">
        <input
          type="search"
          class="h-8 min-w-0 flex-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-13-regular text-text-base outline-none focus:border-v2-border-border-focus"
          aria-label={ctx.t("view.archive.search")}
          placeholder={ctx.t("view.archive.search")}
          value={state.search}
          onInput={(event) => {
            setState("search", event.currentTarget.value)
            state.viewport?.scrollTo({ top: 0 })
          }}
        />
        <span class="text-12-regular text-text-weak">{ctx.plural("view.archive.entries", tree().count)}</span>
      </div>
      <details class="shrink-0 px-4 py-2 text-12-regular text-text-weak">
        <summary class="cursor-pointer">{ctx.t("view.archive.details")}</summary>
        <p class="py-2">{ctx.t("view.archive.boundary")}</p>
      </details>
      <Show
        when={rows().length > 0}
        fallback={
          <div role="status" class="p-4 text-13-regular text-text-weak">
            {ctx.t(tree().count === 0 ? "view.archive.empty" : "view.archive.noResults")}
          </div>
        }
      >
        <div
          ref={(viewport) => setState("viewport", viewport)}
          class="min-h-0 flex-1 overflow-auto"
          aria-label={ctx.t("view.archive.directory")}
        >
          <div role="list" style={{ height: `${virtual.getTotalSize()}px`, position: "relative" }}>
            <For each={virtual.getVirtualItems()}>
              {(item) => {
                const row = () => rows()[item.index]
                const node = () => row()?.node

                return (
                  <Show when={node()}>
                    {(value) => (
                      <div
                        role="listitem"
                        class="absolute inset-x-0 flex h-8 items-center gap-2 px-4 text-13-regular text-text-base"
                        style={{
                          top: `${item.start}px`,
                          "padding-inline-start": `${16 + Math.min(row()?.level ?? 0, 12) * 16}px`,
                        }}
                      >
                        <Show
                          when={value().directory}
                          fallback={
                            <div
                              class="flex min-w-0 flex-1 items-center gap-2"
                              title={value().entries[0]?.name ?? value().path}
                            >
                              <FileIcon node={{ path: value().name, type: "file" }} class="size-4 shrink-0" />
                              <span class="truncate select-text">{value().name}</span>
                            </div>
                          }
                        >
                          <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-2 text-start"
                            aria-expanded={!!state.search.trim() || state.expanded.has(value().id)}
                            title={value().path}
                            onClick={() => toggle(value().id)}
                          >
                            <Icon
                              name={
                                state.search.trim() || state.expanded.has(value().id) ? "chevron-down" : "chevron-right"
                              }
                              size="small"
                            />
                            <FileIcon node={{ path: value().name, type: "directory" }} class="size-4 shrink-0" />
                            <span class="truncate">{value().name}</span>
                          </button>
                        </Show>
                        <Show when={value().duplicate}>
                          <span class="text-12-regular text-text-weak">{ctx.t("view.archive.duplicate")}</span>
                        </Show>
                        <Show when={value().entries.some((entry) => entry.encrypted)}>
                          <span title={ctx.t("view.archive.encrypted")} aria-label={ctx.t("view.archive.encrypted")}>
                            <Icon name="lock" size="small" />
                          </span>
                        </Show>
                        <Show when={value().entries.some((entry) => entry.symlink)}>
                          <span class="text-12-regular text-text-weak">{ctx.t("view.archive.symlink")}</span>
                        </Show>
                        <Show when={value().directory}>
                          <span class="shrink-0 text-12-regular text-text-weak">
                            {ctx.plural("view.archive.entries", value().count)}
                          </span>
                        </Show>
                        <span class="shrink-0 text-12-regular text-text-weak tabular-nums">
                          {formatBytes(ctx.locale.locale(), value().size)}
                        </span>
                      </div>
                    )}
                  </Show>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </>
  )
}
