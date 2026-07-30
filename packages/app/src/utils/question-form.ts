import type { FormInfo, FormMultiselectField, FormStringField } from "@opencode-ai/client/promise"

export type QuestionFormField = FormStringField | FormMultiselectField
export type QuestionForm = Omit<FormInfo, "fields"> & {
  fields: [QuestionFormField, ...QuestionFormField[]]
}

export function isQuestionForm(form: FormInfo): form is QuestionForm {
  if (form.metadata?.kind !== "question") return false
  return form.fields.every((field) => field.type === "string" || field.type === "multiselect")
}

export function questionFormAnswer(form: QuestionForm, answers: ReadonlyArray<ReadonlyArray<string>>) {
  return Object.fromEntries(
    form.fields.flatMap((field, index) => {
      const values = answers[index]
      if (!values?.length) return []
      const selected = values.map((value) => field.options?.find((option) => option.label === value)?.value ?? value)
      return [[field.key, field.type === "multiselect" ? selected : selected[0]]]
    }),
  )
}
