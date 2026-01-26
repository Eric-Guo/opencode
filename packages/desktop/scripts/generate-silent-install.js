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

    // Find all NSIS installers (.exe) and sort by version (newest first)
    const nsisInstallerFiles = files
      .filter((f) => f.includes("x64-setup.exe") && f.includes("OpenCode"))
      .sort((a, b) => {
        // Extract version numbers
        const versionA = a.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"
        const versionB = b.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"

        // Compare versions (newest first)
        return versionB.localeCompare(versionA, undefined, { numeric: true })
      })

    // Find all MSI installers and sort by version (newest first)
    const msiInstallerFiles = files
      .filter((f) => f.includes(".msi") && f.includes("OpenCode"))
      .sort((a, b) => {
        // Extract version numbers
        const versionA = a.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"
        const versionB = b.match(/(\d+\.\d+\.\d+)/)?.[1] || "0.0.0"

        // Compare versions (newest first)
        return versionB.localeCompare(versionA, undefined, { numeric: true })
      })

    let installerFile = null
    let installerType = null

    // Prefer NSIS installer if available, otherwise use MSI
    if (nsisInstallerFiles.length > 0) {
      installerFile = nsisInstallerFiles[0]
      installerType = "nsis"
    } else if (msiInstallerFiles.length > 0) {
      installerFile = msiInstallerFiles[0]
      installerType = "msi"
    }

    if (!installerFile) {
      console.log("⚠️  No NSIS or MSI installer found, skipping silent install script generation")
      return
    }

    console.log(`✅ Found ${installerType.toUpperCase()} installer: ${installerFile}`)

    let baseName = installerFile
      .replace("_x64-setup.exe", "")
      .replace(".msi", "")
      .replace(/_en-US$/, "")
      .replace(/_zh-CN$/, "")

    // Determine silent install arguments based on installer type
    const silentArgs = installerType === "nsis" ? `/S /D="%%LOCALAPPDATA%%\OpenCode"` : `/quiet /norestart`

    // Batch script - silent with minimal output
    const batchScript = `@echo off
title OpenCode Silent Installer
echo Installing ${baseName} silently to %%LOCALAPPDATA%%\OpenCode...
"%~dp0${installerFile}" ${silentArgs}
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

' Set installation path and arguments based on installer type
${
  installerType === "msi"
    ? `
' MSI installer arguments
Dim installArgs
installArgs = "/quiet /norestart"
`
    : `
' NSIS installer arguments
Dim installArgs, installPath
installPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\\OpenCode")
installArgs = "/S /D=""" & installPath & """"
`
}

' Execute silent installation (windowStyle = 0 = hidden, wait = True)
result = shell.Run("""" & installerPath & """ " & installArgs, 0, True)

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

# Build arguments based on installer type
${
  installerType === "msi"
    ? `
# MSI installer arguments
$arguments = "/quiet /norestart"
`
    : `
# NSIS installer arguments
$arguments = "/S /D=\"$InstallPath\""
`
}

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

    // Generate universal versions that work with any installer
    generateUniversalScripts(bundleDir)
  } catch (error) {
    console.error("❌ Error generating silent install scripts:", error)
  }
}

/**
 * Generate universal silent installation scripts that work with any version
 * These scripts auto-detect version from installer filename
 */
function generateUniversalScripts(bundleDir) {
  console.log("\n🔄 Generating universal silent install scripts...")

  // Universal Batch script
  const universalBatchScript = `@echo off
:: OpenCode Universal Silent Installation Batch Script
:: This script automatically detects and installs any version of OpenCode
:: No manual version updates required!

title OpenCode Universal Silent Installation

:: Check for administrator privileges (recommended but not required)
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo =================================================================
    echo    OpenCode Universal Silent Installer
    echo =================================================================
    echo.
    echo WARNING: Administrator privileges not detected.
    echo This script can work without admin rights, but installation might
    echo be limited to your user profile.
    echo.
    choice /C YN /M "Do you want to continue without administrator privileges"
    if errorlevel 2 (
        echo Please run this script as administrator for best results.
        pause
        exit /b 1
    )
)

:: Set console colors and clear screen
cls
echo.
echo =================================================================
echo    OpenCode Universal Silent Installer
echo    自动检测版本 - 无需手动更新
echo =================================================================
echo.

:: Check if the universal VBS script exists
if not exist "opencode-universal-silent-install.vbs" (
    echo ERROR: opencode-universal-silent-install.vbs not found in current directory
    echo.
    echo Please ensure this script is in the same folder as:
    echo   - opencode-universal-silent-install.vbs
    echo   - Any OpenCode installer (e.g., OpenCode_1.1.33_x64-setup.exe)
    echo.
    pause
    exit /b 1
)

:: Look for any OpenCode installer in the current directory
echo Searching for OpenCode installer files...
echo.

set "INSTALLER_FOUND="
for %%f in (*OpenCode*_setup.exe *OpenCode*-*setup.exe) do (
    if exist "%%f" (
        echo Found installer: %%f
        set "INSTALLER_FOUND=%%f"
    )
)

for %%f in (*OpenCode*.exe) do (
    if exist "%%f" (
        echo Found potential installer: %%f
        if not defined INSTALLER_FOUND (
            set "INSTALLER_FOUND=%%f"
        )
    )
)

if not defined INSTALLER_FOUND (
    echo WARNING: No OpenCode installer found in current directory
    echo.
    echo The universal installer will search for any installer file,
    echo but you should verify that an OpenCode installer is present.
    echo.
    echo Expected installer names:
    echo   - OpenCode_1.1.33_x64-setup.exe
    echo   - OpenCode_1.1.34_x64-setup.exe
    echo   - OpenCode-1.1.35-setup.exe
    echo   - etc.
    echo.
    choice /C YN /M "Do you want to continue anyway"
    if errorlevel 2 (
        echo Please place an OpenCode installer in this directory and try again.
        pause
        exit /b 1
    )
) else (
    echo.
    echo Using installer: %INSTALLER_FOUND%
)

:: Execute the universal VBS script silently
echo.
echo Starting universal silent installation process...
echo This will automatically detect the version and install if newer...
echo.

cscript //nologo opencode-universal-silent-install.vbs
set INSTALL_RESULT=%errorlevel%

:: Check the result
echo.
if %INSTALL_RESULT% equ 0 (
    echo =================================================================
    echo    Installation completed successfully!
    echo =================================================================
    echo.
    echo OpenCode has been installed/updated successfully.
    echo The installer automatically detected the version and performed
    echo the update only if a newer version was available.
    echo.
    echo You can find the detailed debug log at:
    echo   %TEMP%\opencode_install.log
) else if %INSTALL_RESULT% equ 1 (
    echo =================================================================
    echo    Installation skipped - already up to date
    echo =================================================================
    echo.
    echo Your current OpenCode installation is already up to date
    echo or newer than the installer version.
    echo.
    echo No changes were made to your system.
    echo You can find the debug log at: %TEMP%\opencode_install.log
) else (
    echo =================================================================
    echo    Installation failed with error code: %INSTALL_RESULT%
    echo =================================================================
    echo.
    echo Please check the debug log at:
    echo   %TEMP%\opencode_install.log
    echo.
    echo for more details about the failure.
    echo.
    echo Common issues:
    echo   - Installer file corrupted
    echo   - Insufficient permissions
    echo   - OpenCode still running (will be automatically terminated)
    echo   - Disk space issues
)

echo.
echo Press any key to exit...
pause >nul
exit /b %INSTALL_RESULT%`

  // Universal VBScript with version auto-detection
  const universalVBScript = `' OpenCode Universal Silent Installer
' Auto-detects version from installer filename - No manual updates needed!

Option Explicit

Dim objShell, objFSO, objShellApp, objWMIService, colProcesses, objProcess
Dim strNewVersion, strCurrentVersion, strInstallerPath, strInstallDir, strLogFile
Dim intNewMajor, intNewMinor, intNewPatch, intCurMajor, intCurMinor, intCurPatch
Dim boolShouldInstall, boolIsRunning, intResult

' === CONFIGURATION ===
' The installer path - can be any NSIS installer with version in filename
strInstallerPath = ""  ' Will be auto-detected
strInstallDir = "%LOCALAPPDATA%\OpenCode"  ' Installation directory
' === END CONFIGURATION ===

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShellApp = CreateObject("Shell.Application")

' Create log file for debugging
strLogFile = objShell.ExpandEnvironmentStrings("%TEMP%\\opencode_install.log")
Dim objLogFile
Set objLogFile = objFSO.CreateTextFile(strLogFile, True)

Sub LogMessage(message)
    objLogFile.WriteLine Now & " - " & message
End Sub

Function FindInstallerFile()
    Dim currentDir, files, file, patternMatches, versionPattern
    Dim bestFile, bestVersion, currentVersion
    Dim fileVersion, filePath
    
    currentDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
    LogMessage "Searching for installer in directory: " & currentDir
    
    ' Pattern to match version numbers in filenames (e.g., "1.1.33", "1.2.0", etc.)
    versionPattern = "(\\d+\\.\\d+\\.\\d+)"
    
    bestFile = ""
    bestVersion = "0.0.0"
    
    ' Get all files in current directory
    Set files = objFSO.GetFolder(currentDir).Files
    
    For Each file In files
        filePath = file.Path
        fileName = objFSO.GetFileName(filePath)
        
        ' Look for NSIS installers (usually end with _x64-setup.exe or -setup.exe)
        If InStr(LCase(fileName), "setup.exe") > 0 And InStr(LCase(fileName), "opencode") > 0 Then
            ' Extract version from filename
            Set patternMatches = CreateObject("VBScript.RegExp")
            patternMatches.Pattern = versionPattern
            patternMatches.Global = False
            
            If patternMatches.Test(fileName) Then
                fileVersion = patternMatches.Execute(fileName)(0).SubMatches(0)
                LogMessage "Found installer: " & fileName & " (version: " & fileVersion & ")"
                
                ' Compare versions and keep the highest one
                If CompareVersions(fileVersion, bestVersion) > 0 Then
                    bestFile = filePath
                    bestVersion = fileVersion
                    LogMessage "Selected as best version so far"
                End If
            Else
                LogMessage "Found installer but couldn't extract version: " & fileName
            End If
        End If
    Next
    
    If bestFile <> "" Then
        LogMessage "Selected installer: " & bestFile & " (version: " & bestVersion & ")"
        strNewVersion = bestVersion
        FindInstallerFile = bestFile
    Else
        LogMessage "No suitable installer found"
        FindInstallerFile = ""
    End If
End Function

Function CompareVersions(version1, version2)
    Dim parts1, parts2, i, maxParts
    
    parts1 = Split(version1, ".")
    parts2 = Split(version2, ".")
    
    maxParts = UBound(parts1)
    If UBound(parts2) > maxParts Then maxParts = UBound(parts2)
    
    For i = 0 To maxParts
        Dim v1, v2
        v1 = 0
        v2 = 0
        
        If i <= UBound(parts1) Then v1 = CLng(parts1(i))
        If i <= UBound(parts2) Then v2 = CLng(parts2(i))
        
        If v1 > v2 Then
            CompareVersions = 1
            Exit Function
        ElseIf v1 < v2 Then
            CompareVersions = -1
            Exit Function
        End If
    Next
    
    CompareVersions = 0
End Function

' Function to parse version string into major.minor.patch
Function ParseVersion(versionStr, ByRef major, ByRef minor, ByRef patch)
    Dim parts
    parts = Split(versionStr, ".")
    
    If UBound(parts) >= 0 Then major = CLng(parts(0)) Else major = 0
    If UBound(parts) >= 1 Then minor = CLng(parts(1)) Else minor = 0
    If UBound(parts) >= 2 Then patch = CLng(parts(2)) Else patch = 0
    
    LogMessage "Parsed version: " & major & "." & minor & "." & patch
End Function

' Function to get current installed version
Function GetCurrentVersion()
    Dim strVersion, strExePath
    strExePath = objShell.ExpandEnvironmentStrings(strInstallDir & "\OpenCode.exe")
    
    LogMessage "Looking for current installation at: " & strExePath
    
    If objFSO.FileExists(strExePath) Then
        On Error Resume Next
        strVersion = objShellApp.Namespace(objFSO.GetParentFolderName(strExePath)).ParseName(objFSO.GetFileName(strExePath)).ExtendedProperty("System.FileVersion")
        On Error GoTo 0
        
        If strVersion <> "" Then
            LogMessage "Found current version: " & strVersion
            GetCurrentVersion = strVersion
        Else
            LogMessage "Could not read version from executable"
            GetCurrentVersion = "0.0.0"
        End If
    Else
        LogMessage "OpenCode.exe not found at expected location"
        GetCurrentVersion = "0.0.0"
    End If
End Function

' Function to check if OpenCode is currently running
Function IsOpenCodeRunning()
    Dim strComputer, strQuery
    strComputer = "."
    Set objWMIService = GetObject("winmgmts:\\" & strComputer & "\root\cimv2")
    strQuery = "SELECT * FROM Win32_Process WHERE Name = 'OpenCode.exe'"
    Set colProcesses = objWMIService.ExecQuery(strQuery)
    
    IsOpenCodeRunning = (colProcesses.Count > 0)
    
    If IsOpenCodeRunning Then
        LogMessage "OpenCode is currently running"
    Else
        LogMessage "OpenCode is not running"
    End If
End Function

' Function to terminate OpenCode processes
Sub TerminateOpenCode()
    Dim strComputer, strQuery, colProcesses, objProcess
    strComputer = "."
    Set objWMIService = GetObject("winmgmts:\\" & strComputer & "\root\cimv2")
    strQuery = "SELECT * FROM Win32_Process WHERE Name = 'OpenCode.exe'"
    Set colProcesses = objWMIService.ExecQuery(strQuery)
    
    For Each objProcess in colProcesses
        LogMessage "Terminating OpenCode process (PID: " & objProcess.ProcessId & ")"
        objProcess.Terminate()
    Next
End Sub

' Main installation logic
Sub Main()
    LogMessage "=== OpenCode Universal Silent Installation Started ==="
    
    ' Auto-find the installer file
    strInstallerPath = FindInstallerFile()
    
    If strInstallerPath = "" Then
        LogMessage "ERROR: No suitable OpenCode installer found in current directory"
        LogMessage "Please ensure you have an OpenCode installer (e.g., OpenCode_1.1.33_x64-setup.exe)"
        objLogFile.Close
        WScript.Quit 1
    End If
    
    LogMessage "New version to compare: " & strNewVersion
    
    ' Get current version
    strCurrentVersion = GetCurrentVersion()
    LogMessage "Current version detected: " & strCurrentVersion
    
    ' Parse versions
    Call ParseVersion(strNewVersion, intNewMajor, intNewMinor, intNewPatch)
    Call ParseVersion(strCurrentVersion, intCurMajor, intCurMinor, intCurPatch)
    
    ' Compare versions
    boolShouldInstall = False
    
    If intNewMajor > intCurMajor Then
        boolShouldInstall = True
        LogMessage "New major version available - should install"
    ElseIf intNewMajor = intCurMajor Then
        If intNewMinor > intCurMinor Then
            boolShouldInstall = True
            LogMessage "New minor version available - should install"
        ElseIf intNewMinor = intCurMinor Then
            If intNewPatch > intCurPatch Then
                boolShouldInstall = True
                LogMessage "New patch version available - should install"
            Else
                LogMessage "Same or older patch version - skip installation"
            End If
        Else
            LogMessage "Older minor version - skip installation"
        End If
    Else
        LogMessage "Older major version - skip installation"
    End If
    
    ' Check if should proceed with installation
    If boolShouldInstall Then
        LogMessage "Proceeding with installation"
        
        ' Check if installer exists
        If Not objFSO.FileExists(strInstallerPath) Then
            LogMessage "ERROR: Installer not found at: " & strInstallerPath
            objLogFile.Close
            WScript.Quit 1
        End If
        
        ' Check if OpenCode is running
        boolIsRunning = IsOpenCodeRunning()
        
        If boolIsRunning Then
            LogMessage "OpenCode is running - will terminate before installation"
            Call TerminateOpenCode()
            WScript.Sleep 2000  ' Wait for processes to terminate
        End If
        
        ' Execute installer silently
        Dim strCommand, intResult
        strCommand = """" & strInstallerPath & """ /S /D="" & objShell.ExpandEnvironmentStrings(strInstallDir)
        LogMessage "Executing installer: " & strCommand
        
        On Error Resume Next
        intResult = objShell.Run(strCommand, 0, True)
        On Error GoTo 0
        
        If intResult = 0 Then
            LogMessage "Installation completed successfully"
            objLogFile.Close
            WScript.Quit 0
        Else
            LogMessage "Installation failed with exit code: " & intResult
            objLogFile.Close
            WScript.Quit intResult
        End If
    Else
        LogMessage "Installation skipped - current version is up to date or newer"
        objLogFile.Close
        WScript.Quit 0
    End If
End Sub

' Execute main function
Call Main()

' Cleanup
objLogFile.Close
Set objShell = Nothing
Set objFSO = Nothing
Set objShellApp = Nothing`

  // Universal PowerShell script
  const universalPowerShellScript = `# OpenCode Universal Silent Installer (PowerShell)
# This script automatically detects and installs any version of OpenCode
# No manual version updates required!

param(
    [string]$InstallerPath = "",
    [string]$InstallPath = "$env:LOCALAPPDATA\OpenCode",
    [switch]$Force,
    [switch]$Silent,
    [switch]$WhatIf
)

# Set error handling
$ErrorActionPreference = 'Continue'

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "$timestamp - [$Level] $Message"
    
    if (-not $Silent) {
        switch ($Level) {
            "ERROR" { Write-Host $logMessage -ForegroundColor Red }
            "WARNING" { Write-Host $logMessage -ForegroundColor Yellow }
            "SUCCESS" { Write-Host $logMessage -ForegroundColor Green }
            default { Write-Host $logMessage }
        }
    }
    
    # Also log to file
    $logFile = "$env:TEMP\opencode_install.log"
    Add-Content -Path $logFile -Value $logMessage -ErrorAction SilentlyContinue
}

function Find-OpenCodeInstaller {
    Write-Log "Searching for OpenCode installer files..."
    
    $currentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $installers = @()
    
    # Look for common installer patterns
    $patterns = @(
        "*OpenCode*_x64-setup.exe",
        "*OpenCode*-*setup.exe", 
        "*OpenCode*_setup.exe",
        "*OpenCode*.exe"
    )
    
    foreach ($pattern in $patterns) {
        $found = Get-ChildItem -Path $currentDir -Name $pattern -ErrorAction SilentlyContinue
        if ($found) {
            foreach ($file in $found) {
                $fullPath = Join-Path $currentDir $file
                $version = Extract-VersionFromFilename $file
                if ($version) {
                    $installers += @{
                        Path = $fullPath
                        Name = $file
                        Version = $version
                    }
                    Write-Log "Found installer: $file (version: $version)"
                }
            }
        }
    }
    
    if ($installers.Count -eq 0) {
        Write-Log "No OpenCode installers found in current directory" "WARNING"
        return $null
    }
    
    # Return the installer with the highest version
    $bestInstaller = $installers | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
    Write-Log "Selected installer: $($bestInstaller.Name) (version: $($bestInstaller.Version))" "SUCCESS"
    
    return $bestInstaller
}

function Extract-VersionFromFilename {
    param([string]$Filename)
    
    # Pattern to match version numbers (e.g., 1.1.33, 1.2.0, etc.)
    $versionPattern = '(\d+\.\d+\.\d+)'
    
    if ($Filename -match $versionPattern) {
        return $matches[1]
    }
    
    return $null
}

function Get-CurrentOpenCodeVersion {
    $exePath = Join-Path $InstallPath "OpenCode.exe"
    
    if (Test-Path $exePath) {
        try {
            $versionInfo = (Get-Item $exePath).VersionInfo
            if ($versionInfo.FileVersion) {
                Write-Log "Current OpenCode version: $($versionInfo.FileVersion)"
                return $versionInfo.FileVersion
            }
        }
        catch {
            Write-Log "Could not read version from executable: $_" "WARNING"
        }
    }
    
    Write-Log "OpenCode not found at $InstallPath or version could not be determined"
    return "0.0.0"
}

function Test-OpenCodeRunning {
    $processes = Get-Process -Name "OpenCode" -ErrorAction SilentlyContinue
    if ($processes) {
        Write-Log "OpenCode is currently running (PID: $($processes.Id -join ', '))"
        return $true
    }
    Write-Log "OpenCode is not running"
    return $false
}

function Stop-OpenCodeProcesses {
    $processes = Get-Process -Name "OpenCode" -ErrorAction SilentlyContinue
    if ($processes) {
        foreach ($process in $processes) {
            Write-Log "Terminating OpenCode process (PID: $($process.Id))"
            try {
                $process | Stop-Process -Force
                Write-Log "Successfully terminated process $($process.Id)"
            }
            catch {
                Write-Log "Failed to terminate process $($process.Id): $_" "ERROR"
            }
        }
        Start-Sleep -Seconds 2
    }
}

function Compare-Versions {
    param([string]$Version1, [string]$Version2)
    
    try {
        $v1 = [version]$Version1
        $v2 = [version]$Version2
        
        if ($v1 -gt $v2) { return 1 }
        elseif ($v1 -lt $v2) { return -1 }
        else { return 0 }
    }
    catch {
        Write-Log "Error comparing versions: $_" "ERROR"
        return 0
    }
}

# Main installation logic
function Install-OpenCode {
    Write-Log "=== OpenCode Universal Silent Installation Started ==="
    
    # Find installer if not specified
    if (-not $InstallerPath) {
        $installer = Find-OpenCodeInstaller
        if (-not $installer) {
            Write-Log "No OpenCode installer found. Please place an OpenCode installer in the same directory as this script." "ERROR"
            return 1
        }
        $InstallerPath = $installer.Path
        $installerVersion = $installer.Version
    }
    else {
        # Validate specified installer
        if (-not (Test-Path $InstallerPath)) {
            Write-Log "Specified installer not found: $InstallerPath" "ERROR"
            return 1
        }
        $installerVersion = Extract-VersionFromFilename (Split-Path -Leaf $InstallerPath)
        if (-not $installerVersion) {
            Write-Log "Could not extract version from installer filename" "WARNING"
            $installerVersion = "1.0.0"
        }
    }
    
    Write-Log "Installer version: $installerVersion"
    
    # Get current version
    $currentVersion = Get-CurrentOpenCodeVersion
    
    # Compare versions
    $versionComparison = Compare-Versions $installerVersion $currentVersion
    
    if ($versionComparison -le 0 -and -not $Force) {
        Write-Log "Installation skipped - current version ($currentVersion) is up to date or newer than installer version ($installerVersion)" "WARNING"
        Write-Log "Use -Force parameter to install anyway"
        return 0
    }
    
    if ($versionComparison -gt 0) {
        Write-Log "Newer version available: $installerVersion > $currentVersion" "SUCCESS"
    }
    
    if ($WhatIf) {
        Write-Log "WhatIf: Would install OpenCode version $installerVersion to $InstallPath"
        return 0
    }
    
    # Check if OpenCode is running
    if (Test-OpenCodeRunning) {
        Write-Log "OpenCode is running - will terminate before installation"
        Stop-OpenCodeProcesses
    }
    
    # Execute installer
    $arguments = "/S /D=\"$InstallPath\""
    Write-Log "Executing installer: $InstallerPath $arguments"
    
    try {
        $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
        
        if ($process.ExitCode -eq 0) {
            Write-Log "Installation completed successfully!" "SUCCESS"
            Write-Log "OpenCode version $installerVersion has been installed to $InstallPath"
            return 0
        }
        else {
            Write-Log "Installation failed with exit code: $($process.ExitCode)" "ERROR"
            return $process.ExitCode
        }
    }
    catch {
        Write-Log "Installation failed: $_" "ERROR"
        return 1
    }
}

# Run the installation
$result = Install-OpenCode

if (-not $Silent) {
    Write-Log ""
    if ($result -eq 0) {
        Write-Log "Installation process completed successfully!" "SUCCESS"
    }
    else {
        Write-Log "Installation process failed with error code: $result" "ERROR"
    }
    Write-Log "Check the log file at: $env:TEMP\opencode_install.log"
}

exit $result`

  // Write universal files
  const universalBatchPath = join(bundleDir, "install-opencode-universal.bat")
  const universalVbsPath = join(bundleDir, "opencode-universal-silent-install.vbs")
  const universalPs1Path = join(bundleDir, "install-opencode-universal.ps1")

  writeFileSync(universalBatchPath, universalBatchScript)
  writeFileSync(universalVbsPath, universalVBScript)
  writeFileSync(universalPs1Path, universalPowerShellScript)

  console.log(`✅ Generated universal silent install scripts:`)
  console.log(`   - ${universalBatchPath}`)
  console.log(`   - ${universalVbsPath}`)
  console.log(`   - ${universalPs1Path}`)
  console.log(`\n🎯 Universal installers work with ANY version - no manual updates needed!`)
}

// Run the generation
generateSilentInstallScripts().catch(console.error)
