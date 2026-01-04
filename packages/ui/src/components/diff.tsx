import { File, type DiffFileProps } from "./file"

export type DiffProps<T = {}> = Omit<DiffFileProps<T>, "mode">

export function Diff<T>(props: DiffProps<T>) {
  return <File mode="diff" {...props} />
}
