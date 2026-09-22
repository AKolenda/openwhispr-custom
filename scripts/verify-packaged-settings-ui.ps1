#requires -Version 7.0
[CmdletBinding()]
param(
  [string]$AppPath,
  [int]$Port = 9431,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $AppPath) {
  $AppPath = Join-Path $Root 'dist\win-unpacked\OpenWhispr.exe'
}
$AppPath = (Resolve-Path -LiteralPath $AppPath).Path
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $Root 'dist\settings-ui-verification'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$savedEnvironment = @{
  OPENWHISPR_UI_TEST = $env:OPENWHISPR_UI_TEST
  OPENWHISPR_CHANNEL = $env:OPENWHISPR_CHANNEL
  VITE_OPENWHISPR_CHANNEL = $env:VITE_OPENWHISPR_CHANNEL
  NODE_ENV = $env:NODE_ENV
}

$process = $null
try {
  $env:OPENWHISPR_UI_TEST = '1'
  $env:OPENWHISPR_CHANNEL = 'staging'
  $env:VITE_OPENWHISPR_CHANNEL = 'staging'
  $env:NODE_ENV = 'production'

  $process = Start-Process -FilePath $AppPath `
    -ArgumentList "--remote-debugging-port=$Port", '--hidden' `
    -WorkingDirectory (Split-Path $AppPath) `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $OutputDirectory 'application.stdout.log') `
    -RedirectStandardError (Join-Path $OutputDirectory 'application.stderr.log') `
    -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      Invoke-RestMethod "http://127.0.0.1:$Port/json/list" | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    throw "Packaged OpenWhispr did not expose its renderer on port $Port."
  }

  & node.exe (Join-Path $Root 'scripts\verify-settings-ui.mjs') $Port `
    "--output-dir=$OutputDirectory"
  if ($LASTEXITCODE -ne 0) {
    throw "Rendered Settings verification failed with exit code $LASTEXITCODE."
  }
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
}
