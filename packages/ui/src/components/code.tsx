import { File, type TextFileProps } from "./file"

export type CodeProps<T = {}> = Omit<TextFileProps<T>, "mode">

export function Code<T>(props: CodeProps<T>) {
  return <File mode="text" {...props} />
}
