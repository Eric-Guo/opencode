import type { Path } from "@/runtime/server/types"
import type { LocationGetInput, LocationGetOutput, ProjectListOutput, ConfigGlobalOutput } from "@opencode/client/promise"
import { retry } from "@opencode/util/retry"
import type { SetStoreFunction } from "solid-js/store"
import type { GlobalStore } from "./types"
import { normalizeProjectInfo } from "./utils"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import type { ServerScope } from "@/runtime/server/scope"
import type { ServerApi } from "@/runtime/server/api"
import { withWorktreeInventory, worktreeInventoryKey } from "@/workspaces/inventory"

type ConfigApi = { readonly global: () => Promise<ConfigGlobalOutput> }

export const loadGlobalConfigQuery = (scope: ServerScope, api: ConfigApi) =>
  queryOptions({
    queryKey: [scope, "config"] as const,
    queryFn: () => retry(() => api.global()),
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
}

type LocationApi = { readonly get: (input?: LocationGetInput) => Promise<LocationGetOutput> }

// Metadata only, in the server's order (most recently active first). Worktree inventories load per project when a
// view shows it (see workspaces/inventory).
export const loadProjectsQuery = (scope: ServerScope, projects: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        projects
          .list()
          .then((items) => items.flatMap((project) => (project?.id ? [normalizeProjectInfo(project)] : []))),
      ),
  })

export function loadProjects(input: {
  scope: ServerScope
  project: ProjectApi
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  return input.queryClient.fetchQuery(loadProjectsQuery(input.scope, input.project)).then((data) =>
    input.setGlobalStore(
      "project",
      data.map((project) =>
        withWorktreeInventory(project, input.queryClient.getQueryData(worktreeInventoryKey(input.scope, project.id))),
      ),
    ),
  )
}

export async function bootstrapGlobal(input: {
  serverAPI: {
    readonly location: LocationApi
    readonly project: ProjectApi
    readonly config: ServerApi["config"]
  }
  scope: ServerScope
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  await Promise.allSettled([
    input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverAPI.config)),
    input.queryClient
      .fetchQuery(loadPathQuery(input.scope, null, input.serverAPI.location))
      .then((data) => input.setGlobalStore("path", data)),
    loadProjects({
      scope: input.scope,
      project: input.serverAPI.project,
      setGlobalStore: input.setGlobalStore,
      queryClient: input.queryClient,
    }),
  ])
}

export function inferHomeDirectory(path: string) {
  const normalized = path.replaceAll("\\", "/")
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(normalized)

  if (!match) return ""

  return path.includes("\\") ? match[1]!.replaceAll("/", "\\") : match[1]!
}

export const loadPathQuery = (scope: ServerScope, directory: string | null, api: LocationApi) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () =>
      api.get(directory ? { location: { directory } } : undefined).then((location) => ({
        state: "",
        config: "",
        worktree: location.project.directory,
        directory: location.directory,
        home: inferHomeDirectory(location.directory) || inferHomeDirectory(location.project.directory),
      })),
  })
