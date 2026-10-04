export type FileManagerOS = "macos" | "windows" | "linux" | "unknown"

type FileManagerAction = {
  label: "session.header.open.finder" | "session.header.open.fileExplorer" | "session.header.open.fileManager"
  actionLabel:
    | "session.header.reveal.finder"
    | "session.header.reveal.fileExplorer"
    | "session.header.reveal.containingFolder"
  icon: "finder" | "file-explorer"
}

export function fileManagerApp(os: FileManagerOS): FileManagerAction {
  if (os === "macos")
    return { label: "session.header.open.finder", actionLabel: "session.header.reveal.finder", icon: "finder" }

  if (os === "windows")
    return {
      label: "session.header.open.fileExplorer",
      actionLabel: "session.header.reveal.fileExplorer",
      icon: "file-explorer",
    }

  return {
    label: "session.header.open.fileManager",
    actionLabel: "session.header.reveal.containingFolder",
    icon: "finder",
  }
}
