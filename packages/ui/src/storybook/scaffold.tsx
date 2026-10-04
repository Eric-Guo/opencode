import { ErrorBoundary, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

function fn<Value, Props extends object>(value: Value): value is Value & Component<Props> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Module export discovery selects callable Solid component exports.
  return typeof value === "function"
}

function pick<Props extends object, Mod extends Record<string, unknown>>(mod: Mod, name?: string): Component<Props> {
  const exports = new Map(
    Object.entries(mod).flatMap(([key, value]) => (fn<unknown, Props>(value) ? [[key, value] as const] : [])),
  )

  const preferred = [...exports.keys()].find((key) => key[0] && key[0] === key[0].toUpperCase())

  const component =
    exports.get(name ?? "") ?? exports.get("default") ?? exports.get(preferred ?? "") ?? exports.values().next().value

  if (component) return component

  return () => {
    return (
      <div data-component="storybook-missing">
        <div>Missing component export.</div>
        <div style="opacity:0.7;font-size:12px">Exports: {Object.keys(mod).join(", ") || "(none)"}</div>
      </div>
    )
  }
}

export function create<Props extends object, Mod extends Record<string, unknown>>(input: {
  title: string
  mod: Mod
  name?: string
  args?: Props
}) {
  const component = pick<Props, Mod>(input.mod, input.name)

  return {
    meta: {
      title: input.title,
      component,
    },
    Basic: {
      args: input.args ?? {},
      render: (args: Props) => {
        return (
          <ErrorBoundary
            fallback={(err) => {
              return (
                <pre data-component="storybook-error" style="white-space:pre-wrap">
                  {String(err)}
                </pre>
              )
            }}
          >
            <Dynamic component={component} {...args} />
          </ErrorBoundary>
        )
      },
    },
  }
}
