export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Robot head */}
      <rect x="2" y="2" width="12" height="10" rx="2" fill="var(--icon-strong-base)" />
      {/* Robot eyes */}
      <circle cx="5" cy="6" r="1.5" fill="var(--icon-weak-base)" />
      <circle cx="11" cy="6" r="1.5" fill="var(--icon-weak-base)" />
      {/* Robot mouth */}
      <rect x="6" y="8" width="4" height="1" rx="0.5" fill="var(--icon-weak-base)" />
      {/* Robot antenna */}
      <line x1="8" y1="2" x2="8" y2="0" stroke="var(--icon-strong-base)" stroke-width="1" />
      <circle cx="8" cy="0" r="0.5" fill="var(--icon-strong-base)" />
      {/* Robot body */}
      <rect x="4" y="13" width="8" height="5" rx="1" fill="var(--icon-strong-base)" />
      {/* Robot body details */}
      <circle cx="6" cy="15" r="0.5" fill="var(--icon-weak-base)" />
      <circle cx="8" cy="15" r="0.5" fill="var(--icon-weak-base)" />
      <circle cx="10" cy="15" r="0.5" fill="var(--icon-weak-base)" />
    </svg>
  )
}

export const Splash = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="logo-splash-gradient"
          x1="24.59"
          y1="98.6"
          x2="170"
          y2="98.6"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stop-color="#05b5f3" />
          <stop offset="0.5" stop-color="#8f63e6" />
          <stop offset="1" stop-color="#eb5ff4" />
        </linearGradient>
      </defs>
      <rect
        x="-2"
        y="-3"
        width="205"
        height="207"
        fill="var(--logo-splash-bg, var(--background-base))"
      />
      <path
        fill="url(#logo-splash-gradient)"
        d="M79,97.39h1.57v18.89H74.17V119h6.39v4.91h-10V119H64.2v-2.7h6.39V97.47H69v-11H79Zm1.42-24.14h-10V83.34h10ZM24.59,83.49h14.2v9.29H34.25V98h4.54v25.93h10.1V98H44.77V92.85h4.12V83.49H63.22V73.39H24.59ZM121.39,98c0,1.38,0,2.31,0,3.54l0,22.24h-9V120.4l-.15-.14c-3.34,2.86-6.81,3.69-11.78,3.69-6.82,0-11.08-4-11.08-10.43,0-8.19,6.62-12.49,22-14.13h-.1V98h4m-4,8.24h-.14a27.17,27.17,0,0,0-4.76.56c-5,1-7.74,3.3-7.74,5.94,0,3,2.17,4.3,5.18,4.3H104c2.59,0,4.88-1.31,7.27-3.7Zm56.43,8.66H165V100.07c0-9.62-3.54-15.35-11.8-15.35-4.74,0-8.4,2.28-11.55,5.17V84.61H131.61v25.71h2.56V116h-2.56v8h10.08v-7.87h2.56v-5.76h-2.56V97.56c2.84-2.76,4.81-4.25,7.93-4.25,3.75,0,5.39,2.12,5.39,8v13.62h5v1.93h-5v7h10V117h5v-2.09ZM121.39,98h4.54v-2h-4.54v-.66c-1.5-7.41-6.73-10.69-14.63-10.69a30.55,30.55,0,0,0-16,5l3.62,6.62c3.55-2,7-3.62,10.51-3.62,3.31,0,5.86,1.18,6.31,3.35h4V98"
      />
      <rect
        x="127.5"
        y="73.91"
        width="4"
        height="3.97"
        fill="var(--logo-splash-muted, var(--text-weak))"
      />
      <path
        fill="var(--logo-splash-muted, var(--text-weak))"
        d="M139.76,75.39h-3.42L135.4,78h-1l3.13-8.34h1.14L141.78,78h-1.11Zm-.26-.74L139,73.29c-.35-.94-.64-1.84-1-2.82h0c-.3,1-.6,1.88-.94,2.82l-.48,1.36Z"
      />
      <path
        fill="var(--logo-splash-muted, var(--text-weak))"
        d="M142.47,79.21a1.78,1.78,0,0,1,1-1.41v0a1.1,1.1,0,0,1-.61-1,1.5,1.5,0,0,1,.75-1.14v0a2.12,2.12,0,0,1-.87-1.65,2.3,2.3,0,0,1,2.5-2.2,3,3,0,0,1,.94.16h2.34v.72H147.1a1.78,1.78,0,0,1,.58,1.33,2.22,2.22,0,0,1-2.44,2.15,2.5,2.5,0,0,1-1-.23,1,1,0,0,0-.45.78c0,.39.28.69,1.2.69h1.36c1.55,0,2.33.44,2.33,1.46s-1.32,2.1-3.37,2.1C143.6,80.87,142.47,80.27,142.47,79.21Zm5.16-.31c0-.6-.48-.8-1.41-.8H145a4.57,4.57,0,0,1-.87-.11,1.36,1.36,0,0,0-.73,1.11c0,.68.75,1.12,2,1.12S147.63,79.56,147.63,78.9Zm-.87-5a1.46,1.46,0,0,0-1.52-1.51,1.44,1.44,0,0,0-1.51,1.51,1.52,1.52,0,1,0,3,0Z"
      />
      <path
        fill="var(--logo-splash-muted, var(--text-weak))"
        d="M149.27,75a3.08,3.08,0,0,1,3-3.24A2.56,2.56,0,0,1,155,74.59a2.38,2.38,0,0,1-.05.56h-4.62a2.22,2.22,0,0,0,2.31,2.27,3.16,3.16,0,0,0,1.72-.5l.38.62a4.25,4.25,0,0,1-2.22.62A3.06,3.06,0,0,1,149.27,75Zm4.79-.47c0-1.32-.65-2-1.76-2a2.08,2.08,0,0,0-2,2Z"
      />
      <path
        fill="var(--logo-splash-muted, var(--text-weak))"
        d="M156.67,71.87h.83l.1.9h0a3.44,3.44,0,0,1,2.29-1.06c1.41,0,2.06.83,2.06,2.4V78h-1v-3.8c0-1.18-.41-1.7-1.35-1.7a2.73,2.73,0,0,0-1.92,1V78h-1Z"
      />
      <path
        fill="var(--logo-splash-muted, var(--text-weak))"
        d="M164.43,76.16V72.63h-1v-.7l1.06-.06.11-1.74h.87v1.74h1.87v.76h-1.87v3.56c0,.76.25,1.21,1.06,1.21a2.58,2.58,0,0,0,.79-.16l.2.7a4.53,4.53,0,0,1-1.2.22C164.88,78.16,164.43,77.37,164.43,76.16Z"
      />
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
        <text
          x="0"
          y="30"
          font-family="var(--font-family-sans)"
          font-size="28"
          font-weight="600"
          letter-spacing="2"
        >
          <tspan fill="var(--icon-base)">Agent</tspan>
          <tspan fill="var(--icon-strong-base)">小天</tspan>
        </text>
      </g>
    </svg>
  )
}
