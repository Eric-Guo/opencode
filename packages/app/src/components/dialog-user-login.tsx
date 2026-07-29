import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export type UserLoginCredentials = {
  username: string
  password: string
}

export function DialogUserLogin(props: {
  onLogin: (credentials: UserLoginCredentials) => Promise<void> | void
  onExit?: () => void
  onCancel?: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [success, setSuccess] = createSignal(false)

  const cancel = () => {
    props.onCancel?.()
    dialog.close()
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!username().trim() || !password() || pending()) return
    setPending(true)
    setError("")
    void Promise.resolve(props.onLogin({ username: username().trim(), password: password() }))
      .then(() => {
        setPassword("")
        setSuccess(true)
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message.split("Error: ").at(-1) ?? message)
      })
      .finally(() => setPending(false))
  }

  return (
    <Dialog fit containerClass="!w-[min(calc(100vw_-_32px),420px)]">
      <form class="contents" onSubmit={submit}>
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("dialog.userLogin.title")}
            description={language.t("dialog.userLogin.description")}
          />
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex w-full flex-col gap-5 px-4 pt-4 pb-2">
          <Show
            when={!success()}
            fallback={
              <div role="status" class="text-14-regular text-text-strong py-2">
                {language.t("dialog.userLogin.success")}
              </div>
            }
          >
            <Field>
              <Field.Label>{language.t("dialog.userLogin.username")}</Field.Label>
              <TextInputV2
                autofocus
                required
                name="username"
                autocomplete="username"
                appearance="large"
                class="!w-full"
                placeholder={language.t("dialog.userLogin.usernamePlaceholder")}
                value={username()}
                disabled={pending()}
                spellcheck={false}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            </Field>
            <Field>
              <Field.Label>{language.t("dialog.userLogin.password")}</Field.Label>
              <TextInputV2
                required
                type="password"
                name="password"
                autocomplete="current-password"
                appearance="large"
                class="!w-full"
                placeholder={language.t("dialog.userLogin.passwordPlaceholder")}
                value={password()}
                disabled={pending()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </Field>
            <Show when={error()}>
              <div role="alert" class="text-12-regular text-text-on-critical-base">
                {error()}
              </div>
            </Show>
          </Show>
        </DialogBody>
        <DialogFooter>
          <Show
            when={!success()}
            fallback={
              <ButtonV2
                type="button"
                variant="contrast"
                onClick={() => (props.onExit ? props.onExit() : dialog.close())}
              >
                {language.t("dialog.userLogin.exit")}
              </ButtonV2>
            }
          >
            <ButtonV2 type="button" variant="neutral" disabled={pending()} onClick={cancel}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2
              type="submit"
              variant={pending() ? "loading" : "contrast"}
              disabled={!username().trim() || !password() || pending()}
            >
              {pending() ? language.t("dialog.userLogin.submitting") : language.t("dialog.userLogin.submit")}
            </ButtonV2>
          </Show>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
