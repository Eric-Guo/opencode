import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const windows = test.skipIf(process.platform !== "win32")

async function harness() {
  const { getMakeNsisPath, getNsisPluginsPath } = await import("app-builder-lib/out/toolsets/windows")
  const { nsisTemplatesDir } = await import("app-builder-lib/out/targets/nsis/nsisUtil")
  const { NsisScriptGenerator } = await import("app-builder-lib/out/targets/nsis/nsisScriptGenerator")
  const config = (await import("../electron-builder.config")).default
  const compiler = await getMakeNsisPath(config.toolsets?.nsis, config.nsis?.customNsisBinary)
  const plugins = await getNsisPluginsPath(config.toolsets?.nsis, config.nsis?.customNsisResources)
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-installer-"))
  // electron-builder generates the command-line flags such as ${isUpdated}.
  const flags = new NsisScriptGenerator()
  flags.flags(["updated"])

  const run = async (cmd: string[], env: Record<string, string> = {}) => {
    const result = Bun.spawn(cmd, { env: { ...process.env, ...compiler.env, ...env }, stdout: "pipe", stderr: "pipe" })

    const [stdout, stderr, code] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ])

    return { stdout: stdout.trim(), stderr, code }
  }

  // Compiles the custom include with the template's flags and messages around one section body.
  const compile = async (name: string, section: string) => {
    const script = path.join(dir, `${name}.nsi`)
    const exe = path.join(dir, `${name}.exe`)
    await Bun.write(
      script,
      `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!addplugindir /x86-unicode "${path.join(plugins, "x86-unicode")}"
!addincludedir "${path.join(nsisTemplatesDir, "include")}"
!include LogicLib.nsh
!include StdUtils.nsh
${flags.build()}
LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\English.nlf"
!include "${config.nsis?.include}"
Section
${section}
SectionEnd
`,
    )
    const result = await run([compiler.path, script])
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)

    return exe
  }

  return {
    dir,
    run,
    compile,
    compiler,
    plugins,
    nsisTemplatesDir,
    config,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

windows(
  "installer grants sandbox access without changing unrelated permissions",
  async () => {
    const installer = await harness()

    const succeed = async (cmd: string[]) => {
      const result = await installer.run(cmd, { OPENCODE_INSTALLER_TEST_ROOT: installer.dir })
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)

      return result.stdout
    }

    const acl = (file: string) =>
      succeed([
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Acl -LiteralPath (Join-Path $env:OPENCODE_INSTALLER_TEST_ROOT '${file}')).Sddl`,
      ])

    try {
      await Bun.write(path.join(installer.dir, "app/runtime/icudtl.dat"), "runtime fixture")
      await Bun.write(path.join(installer.dir, "unrelated.txt"), "outside the installation")
      await succeed(["icacls.exe", path.join(installer.dir, "app"), "/grant", "*S-1-15-2-999-999-999:(OI)(CI)(F)"])
      const parent = await acl(".")
      const unrelated = await acl("unrelated.txt")

      const exe = await installer.compile(
        "acl",
        `  StrCpy $INSTDIR "$EXEDIR\\app"
  !insertmacro customInstall`,
      )

      await succeed([exe])
      const installed = await acl("app/runtime/icudtl.dat")
      expect(installed).toContain("(A;ID;0x1200a9;;;S-1-15-2-2)")
      expect(installed).toContain("S-1-15-2-999-999-999")
      await succeed([exe])
      expect(await acl("app/runtime/icudtl.dat")).toBe(installed)
      expect(await acl(".")).toBe(parent)
      expect(await acl("unrelated.txt")).toBe(unrelated)
    } finally {
      await installer.cleanup()
    }
  },
  120_000,
)

// One-click updates used to flicker backwards during CHECK_APP_RUNNING loops and reset to 0% when
// Nsis7z::Extract ran. Verify the patched installer template compiles cleanly with zero warnings, and
// deterministically verify the monotonic progress controller, control re-IDing, 64-bit extraction math,
// and localized status updates against SpiderBanner without timing-sensitive window polling.
windows(
  "one-click installer progress controller stays strictly monotonic with localized status text",
  async () => {
    const installer = await harness()
    const { NsisScriptGenerator } = await import("app-builder-lib/out/targets/nsis/nsisScriptGenerator")

    const { LangConfigurator, addCustomMessageFileInclude, createAddLangsMacro } = await import(
      "app-builder-lib/out/targets/nsis/nsisLang"
    )

    const uninstallKey = "Software\\OpenCodeInstallerTest"
    const langEn = "$" + "{LANG_ENGLISH}"
    const flags = new NsisScriptGenerator()
    flags.flags(["updated", "force-run", "delete-app-data", "no-desktop-shortcut"])

    const compileStdin = async (script: string) => {
      const proc = Bun.spawn([installer.compiler.path, "-"], {
        cwd: installer.nsisTemplatesDir,
        env: { ...process.env, ...installer.compiler.env },
        stdin: new TextEncoder().encode(script),
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(code, `${stdout}\n${stderr}`).toBe(0)

      return stdout
    }

    try {
      // 1. Real patched ONE_CLICK installer + messages.yml compile cleanly with zero warnings.
      const dummyPayload = path.join(installer.dir, "app.7z")
      const uninstExe = path.join(installer.dir, "uninst.exe")
      const instExe = path.join(installer.dir, "inst.exe")
      await Bun.write(dummyPayload, new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
      await compileStdin(
        ["Unicode true", "RequestExecutionLevel user", "SilentInstall silent", `OutFile "${uninstExe}"`, "Section", "SectionEnd"].join(
          "\n",
        ),
      )

      const langConfig = new LangConfigurator({ multiLanguageInstaller: false })
      const langGen = new NsisScriptGenerator()
      createAddLangsMacro(langGen, langConfig)
      await addCustomMessageFileInclude(
        "messages.yml",
        { getTempFile: async (name: string) => path.join(installer.dir, name) },
        langGen,
        langConfig,
      )

      const compileOut = await compileStdin(
        [
          "Unicode true",
          `OutFile "${instExe}"`,
          `InstallDir "${path.join(installer.dir, "app")}"`,
          "!define ONE_CLICK",
          '!define PRODUCT_NAME "OpenCode"',
          '!define PRODUCT_FILENAME "OpenCode"',
          '!define VERSION "2.0.0"',
          '!define APP_ID "ai.opencode.desktop.progress-test"',
          '!define APP_FILENAME "opencode-progress-test"',
          '!define SHORTCUT_NAME "OpenCode Progress Test"',
          `!define INSTALL_REGISTRY_KEY "${uninstallKey}"`,
          `!define UNINSTALL_REGISTRY_KEY "${uninstallKey}"`,
          '!define UNINSTALL_APP_KEY "opencode-progress-test"',
          '!define UNINSTALL_DISPLAY_NAME "OpenCode Progress Test"',
          `!define UNINSTALLER_OUT_FILE "${uninstExe}"`,
          '!define APP_GUID "opencode-progress-test"',
          `!define APP_64 "${dummyPayload}"`,
          '!define APP_64_HASH "0123456789ABCDEF0123456789ABCDEF"',
          "!define APP_64_UNPACKED_SIZE 3000",
          "!define ESTIMATED_SIZE 3000",
          '!define APP_INSTALLER_STORE_FILE "opencode-progress-test.exe"',
          '!define COMPRESSION_METHOD "7z"',
          "!define DO_NOT_CREATE_START_MENU_SHORTCUT",
          "!define DO_NOT_CREATE_DESKTOP_SHORTCUT",
          `!addplugindir /x86-unicode "${path.join(installer.plugins, "x86-unicode")}"`,
          `!addincludedir "${installer.nsisTemplatesDir}"`,
          `!addincludedir "${path.join(installer.nsisTemplatesDir, "include")}"`,
          "!include LogicLib.nsh",
          "!include StdUtils.nsh",
          "!include FileFunc.nsh",
          "!include MUI2.nsh",
          flags.build(),
          langGen.build(),
          `!include "${installer.config.nsis?.include}"`,
          '!include "installer.nsi"',
        ].join("\n"),
      )

      expect(compileOut.split("\n").filter((line) => /warning/i.test(line))).toEqual([])

      // 2. Deterministic runtime check of the real patched progress functions against SpiderBanner.
      // Extract the patched progress block directly from installer.nsi so we test production code as shipped.
      const nsiSource = await Bun.file(path.join(installer.nsisTemplatesDir, "installer.nsi")).text()
      const start = nsiSource.indexOf("Var /GLOBAL progressBarHwnd")
      const end = nsiSource.indexOf("Function runInstallSection")
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      const progressBlock = nsiSource.slice(start, end)

      const traceFile = path.join(installer.dir, "trace.txt")
      const checkExe = path.join(installer.dir, "check-progress.exe")
      await compileStdin(
        [
          "Unicode true",
          "RequestExecutionLevel user",
          `OutFile "${checkExe}"`,
          `!addplugindir /x86-unicode "${path.join(installer.plugins, "x86-unicode")}"`,
          `!addincludedir "${path.join(installer.nsisTemplatesDir, "include")}"`,
          "!include MUI2.nsh",
          "!include LogicLib.nsh",
          "!insertmacro MUI_PAGE_INSTFILES",
          '!insertmacro MUI_LANGUAGE "English"',
          `LangString extracting ${langEn} "Extracting..."`,
          progressBlock,
          "Var LogH",
          "Var BannerPb",
          "Function Record",
          "  Exch $0",
          "  Push $1",
          "  Push $2",
          "  SendMessage $BannerPb 0x0408 0 0 $1",
          '  System::Call "user32::GetWindowTextW(p $bannerTextHwnd, t .r2, i 256)"',
          '  FileWrite $LogH "$0|$1|$2$\\r$\\n"',
          "  Pop $2",
          "  Pop $1",
          "  Pop $0",
          "FunctionEnd",
          "Function RunCheck",
          `  FileOpen $LogH "${traceFile}" w`,
          "  SpiderBanner::Show /MODERN",
          '  FindWindow $0 "#32770" "" $HWNDPARENT',
          '  FindWindow $1 "#32770" "" $HWNDPARENT $0',
          '  System::Call "user32::SetWindowPos(p $1, p 0, i -32000, i -32000, i 0, i 0, i 0x15)"',
          '  FindWindow $BannerPb "msctls_progress32" "" $1',
          "  Call initInstallProgress",
          // Verify original control ID 1004 is gone so Nsis7z cannot look it up and reset the bar.
          "  GetDlgItem $2 $0 1004",
          '  FileWrite $LogH "id1004|$2|$\\r$\\n"',
          "  !insertmacro setInstallProgress 13500",
          '  Push "set13500"',
          "  Call Record",
          // Backwards update must be ignored.
          "  !insertmacro setInstallProgress 6000",
          '  Push "back6000"',
          "  Call Record",
          // Monotonic creep respects cap.
          "  !insertmacro advanceInstallProgress 300 14000",
          '  Push "adv1"',
          "  Call Record",
          "  !insertmacro advanceInstallProgress 300 14000",
          '  Push "adv2"',
          "  Call Record",
          // 64-bit extraction callback: 350 MiB of 700 MiB -> exact midpoint 19500 (13500 + 6000).
          "  Push 734003200",
          "  Push 367001600",
          "  Call onExtractProgress",
          '  Push "extract50"',
          "  Call Record",
          // Upper clamp at 30000.
          "  !insertmacro setInstallProgress 99999",
          '  Push "clamp"',
          "  Call Record",
          "  FileClose $LogH",
          "  SetErrorLevel 0",
          "  Quit",
          "FunctionEnd",
          "Section",
          "  Call RunCheck",
          "SectionEnd",
        ].join("\n"),
      )

      expect((await installer.run([checkExe])).code).toBe(0)

      const rows = (await Bun.file(traceFile).text())
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split("|"))

      expect(rows).toEqual([
        ["id1004", "0", ""],
        ["set13500", "13500", "Installing, Please Wait..."],
        ["back6000", "13500", "Installing, Please Wait..."],
        ["adv1", "13800", "Installing, Please Wait..."],
        ["adv2", "14000", "Installing, Please Wait..."],
        ["extract50", "19500", "Extracting... 350 / 700 MB"],
        ["clamp", "30000", "Extracting... 350 / 700 MB"],
      ])
    } finally {
      await installer.cleanup()
    }
  },
  120_000,
)
