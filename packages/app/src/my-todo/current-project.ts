import { createMemo } from "solid-js"
import { useData, useServer } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { sameDirectory } from "@/workspaces/paths"
import { projectForSession } from "@/shell/layout/helpers"

export function useMyTodoProject(sessionID?: () => string | undefined) {
  const data = useData()
  const server = useServer()
  const location = useWorkspaceLocation()
  return createMemo(() => {
    const id = sessionID?.()
    const session = id ? data.session.get(id) : undefined
    const projects = server.ctx.projects.list()
    const selected = session
      ? projectForSession(session, projects)
      : projects.find(
          (project) =>
            sameDirectory(project.worktree, location().directory) ||
            project.worktrees?.some((worktree) => sameDirectory(worktree.directory, location().directory)),
        )
    const projectID = selected?.id ?? session?.projectID ?? location().current?.project.id
    return projectID ? data.project.get(projectID) : undefined
  })
}
