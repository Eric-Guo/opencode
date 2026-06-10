import type { JSX, ParentProps } from "solid-js"

export function useParams() {
  return {
    dir: "c3Rvcnk=",
    id: "story-session",
  }
}

export function useNavigate() {
  return () => undefined
}

export function useSearchParams<T extends Record<string, string | undefined>>() {
  return [{} as T, () => undefined] as const
}

export function useLocation() {
  return {
    pathname: "/story/session/story-session",
    search: "",
    hash: "",
  }
}

export function MemoryRouter(props: ParentProps) {
  return props.children
}

export function Router(props: ParentProps) {
  return props.children
}

export function Route(props: ParentProps) {
  return props.children
}

export function Navigate() {
  return undefined
}

export function A(props: ParentProps<{ href?: string; class?: string; classList?: Record<string, boolean> }>) {
  return <a href={props.href} class={props.class} classList={props.classList}>{props.children}</a>
}

export function useMatch() {
  return () => undefined
}

export function useIsRouting() {
  return false
}

export type BaseRouterProps = ParentProps<{ children?: JSX.Element }>
