import { realpath, readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"

/** Installed extension code is trusted; asset requests remain confined to its declared directory. */
export class WebUIModule {
  readonly version = randomUUID()

  private constructor(readonly root: string) {}

  static async open(root: string) {
    if (!isAbsolute(root)) throw new Error("An extension UI needs an absolute asset directory.")

    const module = new WebUIModule(await realpath(root))
    await module.read("index.js")

    return module
  }

  async read(path: string) {
    const file = await realpath(resolve(this.root, path))
    const within = relative(this.root, file)

    if (!within || isAbsolute(within) || within === ".." || within.startsWith(".." + sep))
      throw new Error("The asset is outside this extension's UI directory.")

    if (!(await stat(file)).isFile()) throw new Error("Expected an extension UI file.")

    return {
      content: (await readFile(file)).toString("base64"),
      mime: file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : Bun.file(file).type || "application/octet-stream",
    }
  }
}
