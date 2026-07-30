import { describe, expect, test } from "bun:test"
import type { FormInfo } from "@opencode-ai/client/promise"
import { isQuestionForm, questionFormAnswer } from "./question-form"

const form = {
  id: "frm_question",
  sessionID: "ses_question",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      type: "string",
      options: [{ value: "small", label: "Minimal" }],
      custom: true,
    },
    {
      key: "q1",
      type: "multiselect",
      options: [
        { value: "fast", label: "Fast" },
        { value: "safe", label: "Safe" },
      ],
      custom: true,
    },
  ],
} as FormInfo

describe("question form", () => {
  test("recognizes question-shaped forms", () => {
    expect(isQuestionForm(form)).toBe(true)
    expect(isQuestionForm({ ...form, metadata: { kind: "other" } })).toBe(false)
  })

  test("maps displayed labels and custom answers to form values", () => {
    if (!isQuestionForm(form)) throw new Error("Expected a question form")

    expect(questionFormAnswer(form, [["Minimal"], ["Fast", "Custom"]])).toEqual({
      q0: "small",
      q1: ["fast", "Custom"],
    })
  })
})
