import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
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
        <DividerV2 />
        <DialogBody class="flex w-full flex-col gap-5 px-4 pt-4 pb-2">
          <Field>
            <Field.Label>Username</Field.Label>
            <TextInputV2
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
            <TextInputV2
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
          <ButtonV2 type="button" variant="neutral" onClick={cancel}>
            Cancel
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={!username().trim() || !password()}>
            Log in
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
