import { createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { DialogProvider } from "@opencode/ui/context/dialog"
import {
  I18nProvider,
  pluralCategory,
  pluralKey,
  resolveTemplate,
  useI18n,
  type UiI18nSource,
} from "@opencode/ui/context/i18n"
import { Font } from "@opencode/ui/font"
import { ThemeProvider, useTheme, type ColorScheme } from "@opencode/ui/theme"
import { LanguageProvider, normalizeLocale, UiI18nBridge, useLanguage } from "@/runtime/i18n/language"
import { SettingsProvider } from "@/settings/model"

// These UI dictionaries exercise script-specific rendering outside the app's shipped locales.
const storyDictionaries = import.meta.glob<Record<string, string>>("../../ui/src/i18n/{bn,hi}.ts", {
  eager: true,
  import: "dict",
})

export function StoryProviders(props: ParentProps<{ scheme?: ColorScheme; direction?: string; locale?: string }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider locale={normalizeLocale(props.locale ?? "en")}>
          <UiI18nBridge>
            <Appearance scheme={props.scheme} direction={props.direction} />
            <SettingsProvider>
              <StoryUiLocale locale={props.locale}>
                <DialogProvider>{props.children}</DialogProvider>
              </StoryUiLocale>
            </SettingsProvider>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function StoryUiLocale(props: ParentProps<{ locale?: string }>) {
  const locale = props.locale ?? "en"
  const dictionary = storyDictionaries[`../../ui/src/i18n/${locale}.ts`]

  if (!dictionary) return props.children

  const i18n = useI18n()
  const language = useLanguage()
  const pluralForm: NonNullable<UiI18nSource["pluralForm"]> = (key, category, params) => {
    const template = dictionary[pluralKey(key, category)] ?? dictionary[`${key}.other`]

    return template === undefined ? language.pluralForm(key, category, params) : resolveTemplate(template, params)
  }

  return (
    <I18nProvider
      value={{
        locale: () => locale,
        layoutLocale: i18n.layoutLocale,
        t: (key, params) => {
          const template = dictionary[key]

          return template === undefined ? i18n.t(key, params) : resolveTemplate(template, params)
        },
        plural: (key, count, params) => pluralForm(key, pluralCategory(locale, count), { ...params, count }),
        pluralForm,
      }}
    >
      {props.children}
    </I18nProvider>
  )
}

function Appearance(props: { scheme?: ColorScheme; direction?: string }) {
  const theme = useTheme()

  const language = useLanguage()

  createEffect(() => props.scheme && theme.setColorScheme(props.scheme))
  createEffect(() => {
    document.documentElement.classList.remove("light", "dark")
    document.documentElement.classList.add(theme.mode())
  })
  createEffect(() => language.setDirection(props.direction === "rtl" ? "rtl" : "ltr"))

  // The app derives this attribute from its reduce motion setting; stories follow the system preference.
  onMount(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)")

    const apply = () => (document.documentElement.dataset.motion = motion.matches ? "reduce" : "full")

    apply()
    motion.addEventListener("change", apply)
    onCleanup(() => motion.removeEventListener("change", apply))
  })

  return null
}
