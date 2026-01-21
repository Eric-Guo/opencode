#!/usr/bin/env node

/**
 * Generate silent installation scripts for Windows NSIS installer
 * This script runs automatically after Tauri build
 */

import { writeFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function generateSilentInstallScripts() {
  if (process.platform !== "win32") {
    console.log("⚠️  Skipping silent install script generation on non-Windows host")
    return
  }

  const bundleDir = join(process.cwd(), "src-tauri/target/release/bundle/nsis")

  try {
    // Find the latest NSIS installer
    const fs = await import("fs")
    const files = fs.readdirSync(bundleDir)

    // Find all NSIS installers and sort by version (newest first)
    const installerFiles = files
      .filter((f) => f.includes("x64-setup.exe") && f.includes("OpenCode"))
      .sort((a, b) => {
        // Extract version numbers
        const versionA = a.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"
        const versionB = b.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"

        // Compare versions (newest first)
        return versionB.localeCompare(versionA, undefined, { numeric: true })
      })

    const installerFile = installerFiles[0] // Get the newest version

    if (!installerFile) {
      console.log("⚠️  No NSIS installer found, skipping silent install script generation")
      return
    }

    const baseName = installerFile.replace("_x64-setup.exe", "")

    // Batch script - silent with minimal output
    const batchScript = `@echo off
title OpenCode Silent Installer
echo Installing ${baseName} silently to %%LOCALAPPDATA%%\OpenCode...
"%~dp0${installerFile}" /S /D="%%LOCALAPPDATA%%\OpenCode"
exit /b %errorlevel%`

    // VBScript - completely silent, no UI
    const vbScript = `' OpenCode Silent Installer (Auto-generated) - No UI
' Usage: cscript //nologo silent-install-${baseName}.vbs

On Error Resume Next

Dim shell, fso, installerPath, installPath, result

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get installer path from current directory
installerPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "${installerFile}")

' Check if installer exists (fail silently)
If Not fso.FileExists(installerPath) Then
    WScript.Quit 1
End If

' Set installation path
installPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\\OpenCode")

' Execute silent installation (windowStyle = 0 = hidden, wait = True)
result = shell.Run("""" & installerPath & """ /S /D=""" & installPath & """", 0, True)

' Exit with installer result (no messages)
WScript.Quit result`

    // PowerShell script - silent
    const powerShellScript = `# OpenCode Silent Installer (Auto-generated)
param(
    [string]$InstallPath = "$env:LOCALAPPDATA\OpenCode",
    [switch]$Silent
)

$ErrorActionPreference = 'SilentlyContinue'

# Get installer path
$installerPath = Join-Path $PSScriptRoot "${installerFile}"

if (-not (Test-Path $installerPath)) {
    if (-not $Silent) { Write-Host "Installer not found: $installerPath" -ForegroundColor Red }
    exit 1
}

# Build arguments
$arguments = "/S /D=\"$InstallPath\""

# Execute installation
try {
    $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
} catch {
    if (-not $Silent) { Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red }
    exit 1
}`

    // Write files
    const batchPath = join(bundleDir, `silent-install-${baseName}.bat`)
    const vbsPath = join(bundleDir, `silent-install-${baseName}.vbs`)
    const ps1Path = join(bundleDir, `silent-install-${baseName}.ps1`)

    writeFileSync(batchPath, batchScript)
    writeFileSync(vbsPath, vbScript)
    writeFileSync(ps1Path, powerShellScript)

    console.log(`✅ Generated silent install scripts for ${installerFile}:`)
    console.log(`   - ${batchPath}`)
    console.log(`   - ${vbsPath}`)
    console.log(`   - ${ps1Path}`)
  } catch (error) {
    console.error("❌ Error generating silent install scripts:", error)
  }
}

// Run the generation
generateSilentInstallScripts().catch(console.error)
