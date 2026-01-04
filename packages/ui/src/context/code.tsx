import type { ValidComponent } from "solid-js"
import { createSimpleContext } from "./helper"
import { Code } from "../components/code"

const ctx = createSimpleContext<ValidComponent, { component?: ValidComponent }>({
  name: "CodeComponent",
  init: (props) => props.component ?? Code,
})

export const CodeComponentProvider = ctx.provider
export const useCodeComponent = ctx.use
