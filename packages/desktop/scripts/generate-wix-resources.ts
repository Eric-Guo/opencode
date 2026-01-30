import { readdirSync, existsSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const index = args.indexOf("--config")
const config = index >= 0 ? args[index + 1] : "src-tauri/tauri.conf.json"

const base = path.resolve("src-tauri/resources-dist")
const out = path.resolve("src-tauri/wix/resources.wxs")

const read = async (file) => {
  const text = await Bun.file(file).text()
  return JSON.parse(text)
}

const pick = async () => {
  if (existsSync(config)) {
    return read(config)
  }

  const alt = "src-tauri/tauri.prod.conf.json"
  if (existsSync(alt)) {
    return read(alt)
  }

  return { identifier: "ai.opencode.desktop", productName: "SigmaAgents" }
}

const hash = (text) => {
  const list = Array.from(text)
  const out = list.reduce((acc, ch) => {
    const code = ch.codePointAt(0) ?? 0
    return Math.imul(acc ^ code, 16777619) >>> 0
  }, 2166136261)
  return out.toString(16)
}

const hex = (text) => hash(text).padStart(8, "0")

const guid = (text) => {
  const a = hex(`${text}|0`)
  const b = hex(`${text}|1`)
  const c = hex(`${text}|2`)
  const d = hex(`${text}|3`)
  return `${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d}`
}

const esc = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;")

const win = (text) => text.replace(/\//g, "\\")

const id = (prefix, text) => `${prefix}${hash(text)}`

const tree = (dir, name) => {
  const list = readdirSync(dir, { withFileTypes: true })
  const files = []
  const dirs = []

  for (const entry of list) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      dirs.push(tree(full, entry.name))
      continue
    }

    if (entry.isFile()) {
      if (entry.name === ".DS_Store") {
        continue
      }
      files.push(full)
    }
  }

  return { name, dir, files, dirs }
}

const comp = (file, key, dirId) => {
  const rel = path.relative(base, file).replace(/\\/g, "/")
  const cid = id("C", rel)
  const fid = id("F", rel)
  const gid = guid(rel)
  const src = esc(win(file))
  const xml = [
    `<Component Id="${cid}" Guid="${gid}">`,
    `  <File Id="${fid}" Source="${src}" />`,
    `  <RemoveFolder Id="RF${cid}" Directory="${dirId}" On="uninstall" />`,
    `  <RegistryValue Root="HKCU" Key="${esc(key)}" Name="${cid}" Type="integer" Value="1" KeyPath="yes" />`,
    `</Component>`
  ].join("\n")
  return { xml, id: cid }
}

const cleanup = (dirId, key, rel) => {
  const cid = id("R", rel)
  const gid = guid(`dir:${rel}`)
  const xml = [
    `<Component Id="${cid}" Guid="${gid}">`,
    `  <RemoveFile Id="RFF${cid}" Directory="${dirId}" Name="*" On="uninstall" />`,
    `  <RemoveFolder Id="RF${cid}" Directory="${dirId}" On="uninstall" />`,
    `  <RegistryValue Root="HKCU" Key="${esc(key)}" Name="${cid}" Type="integer" Value="1" KeyPath="yes" />`,
    `</Component>`
  ].join("\n")
  return { xml, id: cid }
}

const pathenv = (key, seed) => {
  const cid = "PathEnv"
  const gid = guid(`${seed}|path-env`)
  const xml = [
    `<Component Id="${cid}" Guid="${gid}">`,
    `  <Environment Id="${cid}" Name="PATH" Value="[INSTALLDIR]" Action="set" Part="first" System="no" />`,
    `  <RegistryValue Root="HKCU" Key="${esc(key)}" Name="${cid}" Type="integer" Value="1" KeyPath="yes" />`,
    `</Component>`
  ].join("\n")
  return { xml, id: cid }
}

const emit = (node, key, parentId) => {
  const rel = path.relative(base, node.dir).replace(/\\/g, "/")
  const dirId = node.name.length > 0 ? id("D", rel) : parentId
  const files = node.files.map((file) => comp(file, key, dirId))
  const kids = node.dirs.map((dir) => emit(dir, key, dirId))
  const clean = node.name.length > 0 ? cleanup(dirId, key, rel) : null
  const body = [
    clean ? clean.xml : "",
    ...files.map((item) => item.xml),
    ...kids.map((item) => item.xml)
  ].filter((item) => item.length > 0)

  const ids = [
    ...(clean ? [clean.id] : []),
    ...files.map((item) => item.id),
    ...kids.flatMap((item) => item.ids)
  ]

  if (node.name.length === 0) {
    return { xml: body.join("\n"), ids }
  }

  const xml = [
    `<Directory Id="${dirId}" Name="${esc(node.name)}">`,
    body.length > 0 ? body.map((line) => `  ${line}`).join("\n") : "",
    `</Directory>`
  ]
    .filter((item) => item.length > 0)
    .join("\n")

  return { xml, ids }
}

const pad = (text, spaces) => {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n")
}

const main = async () => {
  const cfg = await pick()
  // Keep legacy component key to preserve MSI upgrade component key paths.
  const key = "Software\\OpenCode\\Components"
  const seed = cfg.identifier ?? cfg.productName ?? "opencode"
  const env = pathenv(key, seed)

  const data = existsSync(base)
    ? emit(tree(base, ""), key, "INSTALLDIR")
    : { xml: "", ids: [] }

  const body = pad([env.xml, data.xml].filter((item) => item.length > 0).join("\n"), 6)
  const refs = data.ids
    .map((cid) => `      <ComponentRef Id=\"${cid}\" />`)
    .join("\n")

  const xml = [
    `<?xml version=\"1.0\" encoding=\"UTF-8\"?>`,
    `<Wix xmlns=\"http://schemas.microsoft.com/wix/2006/wi\">`,
    `  <Fragment>`,
    `    <DirectoryRef Id=\"INSTALLDIR\">`,
    body,
    `    </DirectoryRef>`,
    `  </Fragment>`,
    `  <Fragment>`,
    `    <ComponentGroup Id=\"AppResources\">`,
    refs,
    `    </ComponentGroup>`,
    `  </Fragment>`,
    `</Wix>`,
    ``
  ].join("\n")

  await Bun.write(out, xml)
}

await main()
