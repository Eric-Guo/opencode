import { type ComponentProps } from "solid-js"

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
      <line
        x1="8"
        y1="2"
        x2="8"
        y2="0"
        stroke="var(--icon-strong-base)"
        {...{ "stroke-width": "1" }}
      />
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

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      id="图层_1"
      data-name="图层 1"
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      {...{ "xmlns:xlink": "http://www.w3.org/1999/xlink" }}
    >
      <defs>
        <style>
          {`.cls-1{fill:none;}.cls-2{clip-path:url(#clip-path);}.cls-3{fill:url(#未命名的渐变_71);}.cls-4{fill:url(#未命名的渐变_17);}`}
        </style>
        <clipPath id="clip-path">
          <rect class="cls-1" x="1147.97" y="-12.82" width="1041.43" height="1046.49" />
        </clipPath>
        <radialGradient
          id="未命名的渐变_71"
          cx="1098.53"
          cy="-207.59"
          r="421"
          gradientTransform="translate(-125.02 734.54) scale(1.34 1.37)"
          gradientUnits="userSpaceOnUse"
        >
          <stop
            offset="0"
            {...{
              "stop-color": "var(--logo-splash-accent, var(--icon-base, #38ade0))",
              "stop-opacity": "0.3",
            }}
          />
          <stop
            offset="0.69"
            {...{
              "stop-color": "var(--logo-splash-accent-2, var(--icon-strong-base, #234fa0))",
              "stop-opacity": "0.1",
            }}
          />
          <stop
            offset="1"
            {...{
              "stop-color": "var(--logo-splash-accent-3, var(--icon-strong-base, #192281))",
              "stop-opacity": "0",
            }}
          />
        </radialGradient>
        <linearGradient
          id="未命名的渐变_17"
          x1="182.22"
          y1="886.82"
          x2="870.68"
          y2="198.35"
          gradientUnits="userSpaceOnUse"
        >
          <stop
            offset="0"
            {...{ "stop-color": "var(--logo-splash-gradient-1, var(--icon-base, #05b5f3))" }}
          />
          <stop
            offset="0.5"
            {...{
              "stop-color": "var(--logo-splash-gradient-2, var(--icon-strong-base, #8f63e6))",
            }}
          />
          <stop
            offset="1"
            {...{ "stop-color": "var(--logo-splash-gradient-3, var(--icon-base, #eb5ff4))" }}
          />
        </linearGradient>
      </defs>
      <title>Sigma</title>
      <g class="cls-2">
        <ellipse class="cls-3" cx="1346.34" cy="449.79" rx="563.88" ry="577.49" />
      </g>
      <polygon
        class="cls-4"
        points="617.91 907.62 622.66 893.6 817.63 893.82 868.47 651.83 821.94 644.52 756.91 746.07 319.32 746.03 329.12 735.61 374.69 735.61 473.22 630.74 495.79 630.74 654.44 461.8 609.08 386.38 761.51 386.38 751.87 375.98 579.78 375.98 587.16 386.38 506.08 386.38 497.72 375.98 497.61 375.87 551.55 375.98 461.82 227.57 484.94 227.57 449.99 169.49 694.84 169.49 768.44 307.44 817.22 301 796.9 124.57 205.19 124.57 205.19 169.49 235.63 216.61 282.92 216.61 290.63 227.62 242.61 227.62 235.63 216.61 119.15 216.61 126.86 227.79 219.56 227.79 219.5 227.73 219.63 227.73 322.22 385.88 373.25 385.88 480.15 551.52 407.16 630.74 384.59 630.74 287.9 735.36 202.58 735.61 101.45 735.36 90.88 745.93 277.72 746.07 202.88 827.23 202.97 851.42 202.82 851.42 203.02 907.62 617.91 907.62 614.02 917.26 891.04 917.26 895.49 907.62 617.91 907.62"
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
          {...{ "font-family": "var(--font-family-sans)" }}
          {...{ "font-size": "28" }}
          {...{ "font-weight": "600" }}
          {...{ "letter-spacing": "2" }}
        >
          <tspan fill="var(--icon-weak-base)">天华</tspan>
          <tspan fill="var(--icon-strong-base)">Σ</tspan>
          <tspan fill="var(--icon-base)">Agents</tspan>
        </text>
      </g>
    </svg>
  )
}
