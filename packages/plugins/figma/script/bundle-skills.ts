import path from "node:path"
import { fileURLToPath } from "node:url"

export async function bundleSkills() {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const files = (
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(root, "skills"), onlyFiles: true }))
  ).toSorted()
  const bundle = await Promise.all(
    files.map(async (file) => ({
      path: file.replaceAll("\\", "/"),
      content: Buffer.from(await Bun.file(path.join(root, "skills", file)).arrayBuffer()).toString("base64"),
    })),
  )
  await Bun.write(
    path.join(root, "../../core/src/plugin/figma-skill/skills-bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  )
}

if (import.meta.main) await bundleSkills()
