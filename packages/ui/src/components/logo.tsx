import { createUniqueId, type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--icon-base)" />
        <path d="M48 30H36V18H48V30Z" fill="var(--icon-weak-base)" />
        <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="var(--icon-base)" />
        <path d="M84 24V30H66V24H84Z" fill="var(--icon-weak-base)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--icon-base)" />
        <path d="M108 36H96V18H108V36Z" fill="var(--icon-weak-base)" />
        <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="var(--icon-base)" />
        <path d="M144 30H126V18H144V30Z" fill="var(--icon-weak-base)" />
        <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="var(--icon-strong-base)" />
        <path d="M168 30H156V18H168V30Z" fill="var(--icon-weak-base)" />
        <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="var(--icon-strong-base)" />
        <path d="M198 30H186V18H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="var(--icon-strong-base)" />
        <path d="M234 24V30H216V24H234Z" fill="var(--icon-weak-base)" />
        <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}

export const Wordmark = (props: { class?: string }) => {
  const filter = createUniqueId()
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720.002 129.001"
      fill="none"
      preserveAspectRatio="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.16" filter={`url(#${filter})`} mask={`url(#${mask})`}>
        <path
          opacity="0.7"
          d="M55.3846 36.8583H18.4615V92.144H55.3846V36.8583ZM73.8462 110.573H0V18.4297H73.8462V110.573Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M110.774 92.144H147.697V36.8583H110.774V92.144ZM166.159 110.573H110.774V129.001H92.3125V18.4297H166.159V110.573Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M258.463 73.7154H203.079V92.144H258.463V110.573H184.617V18.4297H258.463V73.7154ZM203.079 55.2868H240.002V36.8583H203.079V55.2868Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M332.306 36.8583H295.383V110.573H276.922V18.4297H332.306V36.8583ZM350.768 110.573H332.306V36.8583H350.768V110.573Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M443.081 36.8583H387.696V92.144H443.081V110.573H369.234V18.4297H443.081V36.8583Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M516.924 36.8583H480.001V92.144H516.924V36.8583ZM535.385 110.573H461.539V18.4297H535.385V110.573Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M609.228 36.8571H572.305V92.1429H609.228V36.8571ZM627.69 110.571H553.844V18.4286H609.228V0H627.69V110.571Z"
          fill="var(--fill-0, #161616)"
        />
        <path
          opacity="0.7"
          d="M664.618 36.8583V55.2868H701.541V36.8583H664.618ZM720.002 73.7154H664.618V92.144H720.002V110.573H646.156V18.4297H720.002V73.7154Z"
          fill="var(--fill-0, #161616)"
        />
      </g>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="0" x2="360" y2="112" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
        <filter
          id={filter}
          x="0"
          y="0"
          width="720.002"
          height="130.001"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="1" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_4938_16028" />
        </filter>
      </defs>
    </svg>
  )
}
