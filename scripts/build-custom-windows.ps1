#requires -Version 7.0
[CmdletBinding()]
param([switch]$PublishOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$InstallerName = 'OpenWhispr-1.10.2-upstream-escape-v4-x64-Setup.exe'
$Installer = Join-Path $Root "dist\$InstallerName"
$Checksum = "$Installer.sha256"
$Repository = 'AKolenda/openwhispr-custom'
$ReleaseTag = 'custom-v1.10.2-r4'

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Program failed with exit code $LASTEXITCODE."
  }
}

function Invoke-Retry([string]$Program, [string[]]$Arguments, [int]$Attempts = 3) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    & $Program @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq $Attempts) {
      throw "$Program failed after $Attempts attempts."
    }
    Write-Warning "$Program failed on attempt $attempt. Retrying in 5 seconds."
    Start-Sleep -Seconds 5
  }
}

function Import-MsvcEnvironment {
  $vsDevCmd = 'C:\BuildTools\Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw 'Visual Studio Build Tools are missing from C:\BuildTools.'
  }
  $lines = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  foreach ($line in $lines) {
    $parts = $line -split '=', 2
    if ($parts.Count -eq 2) {
      [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
    }
  }
}

Push-Location $Root
try {
  if (-not $PublishOnly) {
    Import-MsvcEnvironment
    foreach ($command in @('git.exe', 'node.exe', 'npm.cmd', 'npx.cmd', 'cl.exe')) {
      if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $command"
      }
    }
    $nodeMajor = [int](& node.exe -p 'process.versions.node.split(".")[0]')
    if ($nodeMajor -ne 24) { throw "Node.js 24 is required. Found major version $nodeMajor." }

    $env:OPENWHISPR_CHANNEL = 'production'
    $env:VITE_OPENWHISPR_CHANNEL = 'production'
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:BRAND_FONTS_REQUIRED = '0'
    Set-Content -LiteralPath '.env' -Encoding utf8NoBOM -Value 'OPENWHISPR_CHANNEL=production'

    Invoke-Checked 'npm.cmd' @('ci')
    Invoke-Checked 'node.exe' @('--import', 'tsx', '--test',
      'test/services/openRouterRouting.test.js',
      'test/helpers/escapeCancellation.test.js',
      'test/services/escapeCancellationPreference.test.js',
      'test/helpers/agentNameDictionaryDefault.test.js')
    Invoke-Checked 'npm.cmd' @('run', 'typecheck')
    Invoke-Checked 'npm.cmd' @('install', '--no-save', '--package-lock=false', '--legacy-peer-deps',
      '@rollup/rollup-win32-x64-msvc', 'lightningcss-win32-x64-msvc',
      '@tailwindcss/oxide-win32-x64-msvc')

    Invoke-Checked 'npm.cmd' @('run', 'compile:native')
    foreach ($download in @(
      @('scripts/download-whisper-cpp.js', '--current'),
      @('scripts/download-llama-server.js', '--current'),
      @('scripts/download-sherpa-onnx.js', '--current'),
      @('scripts/download-yt-dlp.js', '--current'),
      @('scripts/download-qdrant.js', '--current'),
      @('scripts/download-meeting-aec-helper.js', '--current'),
      @('scripts/download-whisper-vad-model.js'),
      @('scripts/download-diarization-models.js', '--output-dir', 'resources/bin/diarization-models'),
      @('scripts/download-nircmd.js'),
      @('scripts/download-windows-fast-paste.js'),
      @('scripts/download-windows-key-listener.js'),
      @('scripts/download-windows-system-audio-helper.js'),
      @('scripts/download-brand-fonts.js')
    )) {
      Invoke-Retry 'node.exe' $download
    }

    New-Item -ItemType Directory -Force -Path 'resources/bin' | Out-Null
    Invoke-Checked 'cl.exe' @('/O2', '/nologo', 'resources\windows-mic-listener.c',
      '/Fe:resources\bin\windows-mic-listener.exe', 'ole32.lib', 'oleaut32.lib')
    $rendererOutput = Join-Path $Root 'src\dist'
    if (-not $rendererOutput.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean renderer output outside the repository: $rendererOutput"
    }
    Remove-Item -LiteralPath $rendererOutput -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-Checked 'npm.cmd' @('run', 'build:renderer')
    Remove-Item -LiteralPath $Installer, $Checksum, "$Installer.blockmap" -Force -ErrorAction SilentlyContinue
    Invoke-Checked 'npx.cmd' @('--no-install', 'electron-builder', '--win', 'nsis', '--x64',
      '--publish', 'never', '--config', 'electron-builder.routing-win.json')

    if (-not (Test-Path -LiteralPath $Installer)) {
      throw "Expected installer was not created: $Installer"
    }
    Invoke-Checked 'pwsh.exe' @('-NoProfile', '-File',
      'scripts\verify-packaged-settings-ui.ps1')
    $hash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $Checksum -Encoding ascii -Value "$hash  $InstallerName"
    Write-Host "Built and verified: $Installer"
  }

  if ($PublishOnly) {
    if (-not (Test-Path -LiteralPath $Installer) -or -not (Test-Path -LiteralPath $Checksum)) {
      throw 'Build artifacts are missing. Run this script without -PublishOnly first.'
    }
    Invoke-Checked 'gh.exe' @('auth', 'status')
    & gh.exe release view $ReleaseTag --repo $Repository *> $null
    if ($LASTEXITCODE -eq 0) {
      Invoke-Checked 'gh.exe' @('release', 'upload', $ReleaseTag, $Installer, $Checksum,
        '--repo', $Repository, '--clobber')
    } else {
      Invoke-Checked 'gh.exe' @('release', 'create', $ReleaseTag, $Installer, $Checksum,
        '--repo', $Repository, '--title', 'OpenWhispr 1.10.2 custom Windows build r4',
        '--notes-file', 'CUSTOM-BUILD.md')
    }
    Write-Host "Published: https://github.com/$Repository/releases/tag/$ReleaseTag"
  } else {
    Write-Host 'Build complete. After GitHub login, run again with -PublishOnly.'
  }
} finally {
  Pop-Location
}
