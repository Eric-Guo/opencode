import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { createSignal, onMount } from "solid-js"
import { SelectProjectDialog } from "./select-project-dialog"
import projects from "./select-project-dialog.mock.json"

function SelectProjectStory() {
  const dialog = useDialog()
  const [workPackageID, setWorkPackageID] = createSignal(projects[0]?.work_package_id)
  const selected = () => projects.find((project) => project.work_package_id === workPackageID())
  const open = () =>
    dialog.show(() => (
      <SelectProjectDialog
        projects={projects}
        value={workPackageID()}
        onSelect={(project) => {
          setWorkPackageID(project.work_package_id)
          dialog.close()
        }}
      />
    ))

  onMount(open)

  return (
    <Button variant="neutral" onClick={open}>
      {selected()?.project_name ?? "Select my todo project"}
    </Button>
  )
}

export default {
  title: "App/Dialogs/Select Project",
  id: "app-dialog-select-project",
}

export const MyTodo = {
  render: () => <SelectProjectStory />,
}
