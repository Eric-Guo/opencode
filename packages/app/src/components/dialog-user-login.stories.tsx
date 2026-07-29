// @ts-nocheck
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { onMount } from "solid-js"
import { DialogUserLogin } from "./dialog-user-login"

function UserLoginDialogStory() {
  const dialog = useDialog()
  const open = () => dialog.show(() => <DialogUserLogin onLogin={() => {}} />)

  onMount(open)

  return (
    <Button variant="secondary" onClick={open}>
      Open user login dialog
    </Button>
  )
}

export default {
  title: "App/Dialogs/User Login",
  id: "app-dialog-user-login",
}

export const Default = {
  render: () => <UserLoginDialogStory />,
}
