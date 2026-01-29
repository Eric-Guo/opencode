// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import solidJs from "@astrojs/solid-js"
import cloudflare from "@astrojs/cloudflare"
import theme from "toolbeam-docs-theme"
import config from "./config.mjs"
import { rehypeHeadingIds, unified } from "@astrojs/markdown-remark"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import { copyFileSync } from "fs"
import { execFileSync } from "child_process"
import { setFlagsFromString } from "v8"

// Node 24+ can deadlock in process.exit() when a background V8 compile job waits for a GC the exiting main thread
// never runs, so `astro build` prints "Complete!" and never exits (https://github.com/nodejs/node/issues/64274).
setFlagsFromString("--no-maglev")
setFlagsFromString("--no-concurrent-sparkplug")

// https://astro.build/config
export default defineConfig({
  site: config.url,
  base: "/docs",
  output: "server",
  adapter: cloudflare({
    configPath: process.env.SST_WRANGLER_PATH,
    imageService: "passthrough",
    // toolbeam-docs-theme passes its options to components through globalThis, which only works when pages
    // prerender in the same Node process as the config.
    prerenderEnvironment: "node",
  }),
  devToolbar: {
    enabled: false,
  },
  server: {
    host: "0.0.0.0",
  },
  markdown: {
    processor: unified({
      rehypePlugins: [rehypeHeadingIds, [rehypeAutolinkHeadings, { behavior: "wrap" }]],
    }),
  },
  build: {},
  integrations: [
    configSchema(),
    solidJs(),
    starlight({
      title: "OpenCode",
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
          dir: "ltr",
        },
        "zh-cn": {
          label: "简体中文",
          lang: "zh-CN",
          dir: "ltr",
        },
      },
      favicon: "/favicon-v3.svg",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon-v3.ico",
            sizes: "32x32",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            href: "/favicon-96x96-v3.png",
            sizes: "96x96",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: "/apple-touch-icon-v3.png",
            sizes: "180x180",
          },
        },
      ],
      lastUpdated: true,
      expressiveCode: { themes: ["github-light", "github-dark"] },
      social: [
        { icon: "github", label: "GitHub", href: config.github },
        { icon: "discord", label: "Discord", href: config.discord },
      ],
      editLink: {
        baseUrl: `${config.github}/edit/dev/packages/web/`,
      },
      markdown: {
        headingLinks: false,
      },
      customCss: ["./src/styles/custom.css"],
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      sidebar: [
        "",
        "config",
        "providers",
        "network",
        "enterprise",
        "troubleshooting",
        {
          label: "Windows",
          translations: {
            en: "Windows",
            "zh-CN": "Windows",
          },
          link: "windows-wsl",
        },
        {
          label: "Usage",
          translations: {
            en: "Usage",
            "zh-CN": "使用",
          },
          items: [
            { label: "Go", link: "https://opencode.ai/v2/docs/console/go/" },
            "tui",
            "cli",
            "web",
            "ide",
            { label: "Console", link: "https://opencode.ai/v2/docs/console/" },
            "github",
            "gitlab",
          ],
        },

        {
          label: "Configure",
          translations: {
            en: "Configure",
            "zh-CN": "配置",
          },
          items: [
            "tools",
            "rules",
            "agents",
            "models",
            "themes",
            "keybinds",
            "commands",
            "formatters",
            "permissions",
            "policies",
            "lsp",
            "mcp-servers",
            "acp",
            "skills",
            "references",
            "custom-tools",
          ],
        },

        {
          label: "Develop",
          translations: {
            en: "Develop",
            "zh-CN": "开发",
          },
          items: ["sdk", "server", "plugins", "ecosystem"],
        },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
        PageFrame: "./src/components/PageFrame.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        LanguageSelect: "./src/components/LanguageSelect.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      plugins: [
        theme({
          headerLinks: config.headerLinks,
        }),
      ],
    }),
  ],
})

function configSchema() {
  return {
    name: "configSchema",
    hooks: {
      "astro:build:done": async () => {
        execFileSync("bun", ["../schema/script/config-schema.ts", "./dist/client/config.json"], { stdio: "inherit" })
        // The V1 TUI schema is frozen in the console app since packages/opencode lives on the v1 branch.
        copyFileSync("../console/app/public/tui.json", "./dist/client/tui.json")
      },
    },
  }
}
