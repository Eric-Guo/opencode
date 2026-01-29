import { defineCollection, z } from "astro:content"
import { glob } from "astro/loaders"
import { i18nLoader } from "@astrojs/starlight/loaders"
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema"
import en from "./content/i18n/en.json"

const custom = Object.fromEntries(Object.keys(en).map((key) => [key, z.string()]))
const ext = "markdown,mdown,mkdn,mkd,mdwn,md,mdx"
const pat = [`**/[^_]*.{${ext}}`, "!{ar,bs,da,de,es,fr,it,ja,ko,nb,pl,pt-br,ru,th,tr,zh-tw}/**"]

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "./src/content/docs",
      pattern: pat,
    }),
    schema: docsSchema(),
  }),
  i18n: defineCollection({
    loader: i18nLoader(),
    schema: i18nSchema({
      extend: z.object(custom).catchall(z.string()),
    }),
  }),
}
