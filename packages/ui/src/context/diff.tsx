import type { ValidComponent } from "solid-js"
import { createSimpleContext } from "./helper"
import { Diff } from "../components/diff"

const ctx = createSimpleContext<ValidComponent, { component?: ValidComponent }>({
  name: "DiffComponent",
  init: (props) => props.component ?? Diff,
})

export const DiffComponentProvider = ctx.provider
export const useDiffComponent = ctx.use
