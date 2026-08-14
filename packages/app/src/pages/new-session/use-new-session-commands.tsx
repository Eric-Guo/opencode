import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

export function useNewSessionCommands(input: {
  restoreFocus: () => void
  project: {
    empty: () => boolean
    open: () => void
  }
}) {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()

  useSettingsCommand()
  // The palette handler is page-specific, so all pages register it under one
  // shared key: during route transitions two pages stay mounted at once and the
  // newest registration shadows the previous one instead of duplicating the id.
  command.register("command.palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const { DialogCommandPalette } = await import("@/components/dialog-command-palette")
        void dialog.show(() => <DialogCommandPalette />)
      },
    },
  ])
  command.register("session", () => [
    {
      id: "input.focus",
      title: language.t("command.input.focus"),
      category: language.t("command.category.view"),
      keybind: "ctrl+l",
      onSelect: input.restoreFocus,
    },
    {
      id: "project.select",
      title: language.t("session.new.project.search"),
      category: language.t("command.category.project"),
      keybind: "mod+shift+o",
      disabled: input.project.empty(),
      onSelect: input.project.open,
    },
  ])
}
