import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Divider } from "@opencode/ui/divider"
import { Field } from "@opencode/ui/field"
import { TextInput } from "@opencode/ui/text-input"
import { useDialog } from "@opencode/ui/context/dialog"
import { createSignal } from "solid-js"

export type UserLoginCredentials = {
  username: string
  password: string
}

export function DialogUserLogin(props: {
  onLogin: (credentials: UserLoginCredentials) => void
  onCancel?: () => void
}) {
  const dialog = useDialog()
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")

  const cancel = () => {
    props.onCancel?.()
    dialog.close()
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!username().trim() || !password()) return
    props.onLogin({ username: username().trim(), password: password() })
  }

  return (
    <Dialog fit containerClass="!w-[min(calc(100vw_-_32px),420px)]">
      <form class="contents" onSubmit={submit}>
        <DialogHeader>
          <DialogTitleGroup title="User login" description="Enter your username and password to continue." />
        </DialogHeader>
        <Divider />
        <DialogBody class="flex w-full flex-col gap-5 px-4 pt-4 pb-2">
          <Field>
            <Field.Label>Username</Field.Label>
            <TextInput
              autofocus
              required
              name="username"
              autocomplete="username"
              appearance="large"
              class="!w-full"
              placeholder="Enter username"
              value={username()}
              spellcheck={false}
              onInput={(event) => setUsername(event.currentTarget.value)}
            />
          </Field>
          <Field>
            <Field.Label>Password</Field.Label>
            <TextInput
              required
              type="password"
              name="password"
              autocomplete="current-password"
              appearance="large"
              class="!w-full"
              placeholder="Enter password"
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="neutral" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" variant="contrast" disabled={!username().trim() || !password()}>
            Log in
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
