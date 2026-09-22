#requires -Version 7.0
[CmdletBinding()]
param(
  [string]$AppPath,
  [int]$Port = 9431,
  [string]$OutputDirectory,
  [switch]$PreserveState
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

$appDirectory = Split-Path $AppPath
$asarPath = Join-Path $appDirectory 'resources\app.asar'
$asarCommand = Join-Path $Root 'node_modules\.bin\asar.cmd'
if (-not (Test-Path -LiteralPath $asarPath) -or -not (Test-Path -LiteralPath $asarCommand)) {
  throw 'Packaged app.asar or the asar reader is missing.'
}
$runtimeCheck = Join-Path $OutputDirectory 'runtime-env-check'
New-Item -ItemType Directory -Force -Path $runtimeCheck | Out-Null
Push-Location $runtimeCheck
try {
  & $asarCommand extract-file $asarPath 'src\dist\runtime-env.json'
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the packaged runtime environment.' }
} finally {
  Pop-Location
}
$runtimeEnv = Get-Content -LiteralPath (Join-Path $runtimeCheck 'runtime-env.json') -Raw | ConvertFrom-Json
if ($runtimeEnv.VITE_OPENWHISPR_API_URL -ne 'https://api.openwhispr.com' -or
    $runtimeEnv.VITE_AUTH_URL -ne 'https://auth.openwhispr.com') {
  throw 'The packaged renderer is missing the official OpenWhispr API or authentication URL.'
}

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

  $verifyArguments = @(
    (Join-Path $Root 'scripts\verify-settings-ui.mjs'),
    $Port,
    "--output-dir=$OutputDirectory"
  )
  if ($PreserveState) { $verifyArguments += '--preserve-state' }
  & node.exe @verifyArguments
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
