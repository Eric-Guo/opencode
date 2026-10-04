import type { DesktopTheme } from "./types"
import oc2ThemeJson from "./themes/oc-2.json"
import amoledThemeJson from "./themes/amoled.json"
import auraThemeJson from "./themes/aura.json"
import ayuThemeJson from "./themes/ayu.json"
import carbonfoxThemeJson from "./themes/carbonfox.json"
import catppuccinThemeJson from "./themes/catppuccin.json"
import catppuccinFrappeThemeJson from "./themes/catppuccin-frappe.json"
import catppuccinMacchiatoThemeJson from "./themes/catppuccin-macchiato.json"
import cobalt2ThemeJson from "./themes/cobalt2.json"
import cursorThemeJson from "./themes/cursor.json"
import draculaThemeJson from "./themes/dracula.json"
import everforestThemeJson from "./themes/everforest.json"
import flexokiThemeJson from "./themes/flexoki.json"
import githubThemeJson from "./themes/github.json"
import gruvboxThemeJson from "./themes/gruvbox.json"
import kanagawaThemeJson from "./themes/kanagawa.json"
import lucentOrngThemeJson from "./themes/lucent-orng.json"
import materialThemeJson from "./themes/material.json"
import matrixThemeJson from "./themes/matrix.json"
import mercuryThemeJson from "./themes/mercury.json"
import monokaiThemeJson from "./themes/monokai.json"
import nightowlThemeJson from "./themes/nightowl.json"
import nordThemeJson from "./themes/nord.json"
import oneDarkThemeJson from "./themes/one-dark.json"
import oneDarkProThemeJson from "./themes/onedarkpro.json"
import orngThemeJson from "./themes/orng.json"
import osakaJadeThemeJson from "./themes/osaka-jade.json"
import palenightThemeJson from "./themes/palenight.json"
import rosepineThemeJson from "./themes/rosepine.json"
import shadesOfPurpleThemeJson from "./themes/shadesofpurple.json"
import solarizedThemeJson from "./themes/solarized.json"
import synthwave84ThemeJson from "./themes/synthwave84.json"
import tokyonightThemeJson from "./themes/tokyonight.json"
import vercelThemeJson from "./themes/vercel.json"
import vesperThemeJson from "./themes/vesper.json"
import zenburnThemeJson from "./themes/zenburn.json"

const sources = {
  oc2Theme: oc2ThemeJson,
  amoledTheme: amoledThemeJson,
  auraTheme: auraThemeJson,
  ayuTheme: ayuThemeJson,
  carbonfoxTheme: carbonfoxThemeJson,
  catppuccinTheme: catppuccinThemeJson,
  catppuccinFrappeTheme: catppuccinFrappeThemeJson,
  catppuccinMacchiatoTheme: catppuccinMacchiatoThemeJson,
  cobalt2Theme: cobalt2ThemeJson,
  cursorTheme: cursorThemeJson,
  draculaTheme: draculaThemeJson,
  everforestTheme: everforestThemeJson,
  flexokiTheme: flexokiThemeJson,
  githubTheme: githubThemeJson,
  gruvboxTheme: gruvboxThemeJson,
  kanagawaTheme: kanagawaThemeJson,
  lucentOrngTheme: lucentOrngThemeJson,
  materialTheme: materialThemeJson,
  matrixTheme: matrixThemeJson,
  mercuryTheme: mercuryThemeJson,
  monokaiTheme: monokaiThemeJson,
  nightowlTheme: nightowlThemeJson,
  nordTheme: nordThemeJson,
  oneDarkTheme: oneDarkThemeJson,
  oneDarkProTheme: oneDarkProThemeJson,
  orngTheme: orngThemeJson,
  osakaJadeTheme: osakaJadeThemeJson,
  palenightTheme: palenightThemeJson,
  rosepineTheme: rosepineThemeJson,
  shadesOfPurpleTheme: shadesOfPurpleThemeJson,
  solarizedTheme: solarizedThemeJson,
  synthwave84Theme: synthwave84ThemeJson,
  tokyonightTheme: tokyonightThemeJson,
  vercelTheme: vercelThemeJson,
  vesperTheme: vesperThemeJson,
  zenburnTheme: zenburnThemeJson,
}

type BuiltinThemes = { [Name in keyof typeof sources]: DesktopTheme }

// SAFETY: These bundled assets follow the DesktopTheme schema; JSON imports widen their hex and CSS literals to string.
const themes = sources as BuiltinThemes

export const oc2Theme = themes.oc2Theme

export const amoledTheme = themes.amoledTheme

export const auraTheme = themes.auraTheme

export const ayuTheme = themes.ayuTheme

export const carbonfoxTheme = themes.carbonfoxTheme

export const catppuccinTheme = themes.catppuccinTheme

export const catppuccinFrappeTheme = themes.catppuccinFrappeTheme

export const catppuccinMacchiatoTheme = themes.catppuccinMacchiatoTheme

export const cobalt2Theme = themes.cobalt2Theme

export const cursorTheme = themes.cursorTheme

export const draculaTheme = themes.draculaTheme

export const everforestTheme = themes.everforestTheme

export const flexokiTheme = themes.flexokiTheme

export const githubTheme = themes.githubTheme

export const gruvboxTheme = themes.gruvboxTheme

export const kanagawaTheme = themes.kanagawaTheme

export const lucentOrngTheme = themes.lucentOrngTheme

export const materialTheme = themes.materialTheme

export const matrixTheme = themes.matrixTheme

export const mercuryTheme = themes.mercuryTheme

export const monokaiTheme = themes.monokaiTheme

export const nightowlTheme = themes.nightowlTheme

export const nordTheme = themes.nordTheme

export const oneDarkTheme = themes.oneDarkTheme

export const oneDarkProTheme = themes.oneDarkProTheme

export const orngTheme = themes.orngTheme

export const osakaJadeTheme = themes.osakaJadeTheme

export const palenightTheme = themes.palenightTheme

export const rosepineTheme = themes.rosepineTheme

export const shadesOfPurpleTheme = themes.shadesOfPurpleTheme

export const solarizedTheme = themes.solarizedTheme

export const synthwave84Theme = themes.synthwave84Theme

export const tokyonightTheme = themes.tokyonightTheme

export const vercelTheme = themes.vercelTheme

export const vesperTheme = themes.vesperTheme

export const zenburnTheme = themes.zenburnTheme

export const DEFAULT_THEMES = {
  "oc-2": oc2Theme,
  amoled: amoledTheme,
  aura: auraTheme,
  ayu: ayuTheme,
  carbonfox: carbonfoxTheme,
  catppuccin: catppuccinTheme,
  "catppuccin-frappe": catppuccinFrappeTheme,
  "catppuccin-macchiato": catppuccinMacchiatoTheme,
  cobalt2: cobalt2Theme,
  cursor: cursorTheme,
  dracula: draculaTheme,
  everforest: everforestTheme,
  flexoki: flexokiTheme,
  github: githubTheme,
  gruvbox: gruvboxTheme,
  kanagawa: kanagawaTheme,
  "lucent-orng": lucentOrngTheme,
  material: materialTheme,
  matrix: matrixTheme,
  mercury: mercuryTheme,
  monokai: monokaiTheme,
  nightowl: nightowlTheme,
  nord: nordTheme,
  "one-dark": oneDarkTheme,
  onedarkpro: oneDarkProTheme,
  orng: orngTheme,
  "osaka-jade": osakaJadeTheme,
  palenight: palenightTheme,
  rosepine: rosepineTheme,
  shadesofpurple: shadesOfPurpleTheme,
  solarized: solarizedTheme,
  synthwave84: synthwave84Theme,
  tokyonight: tokyonightTheme,
  vercel: vercelTheme,
  vesper: vesperTheme,
  zenburn: zenburnTheme,
} satisfies Record<string, DesktopTheme>
