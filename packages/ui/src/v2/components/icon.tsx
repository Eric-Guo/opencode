import { type ComponentProps, splitProps } from "solid-js"

const icons = {
  "grid-plus": (
    <path
      d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z"
      stroke="currentColor"
      stroke-miterlimit="10"
      stroke-linecap="square"
    />
  ),
  plus: (
    <>
      <path d="M8 2.88867V13.1109" stroke="currentColor" stroke-linejoin="round" />
      <path d="M2.88867 8H13.1109" stroke="currentColor" stroke-linejoin="round" />
    </>
  ),
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  const icon = () => icons[split.name as keyof typeof icons] ?? icons.plus

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      width={pixelSize}
      height={pixelSize}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      {icon()}
    </svg>
  )
}
