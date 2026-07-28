# Builds dist/crunchyroll-auto-skip-<version>.zip, containing only the files the
# browser needs. Run tests first; refuse to package a failing build.
#
#   pwsh ./package.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

node test/selftest.js
if ($LASTEXITCODE -ne 0) { throw 'Tests failed - not packaging.' }

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$staging = Join-Path $env:TEMP "cras-$version"
$dist = Join-Path $PSScriptRoot 'dist'
$zip = Join-Path $dist "crunchyroll-auto-skip-$version.zip"

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force $staging | Out-Null
New-Item -ItemType Directory -Force $dist | Out-Null

# Everything the extension loads at runtime, and nothing else.
$files = @(
  'manifest.json',
  'matchers.js',
  'content.js',
  'settings.html',
  'settings.css',
  'settings.js',
  'LICENSE'
)
foreach ($file in $files) { Copy-Item $file $staging }
Copy-Item 'icons' $staging -Recurse

if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
Remove-Item -Recurse -Force $staging

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output "Packaged v$version -> dist/crunchyroll-auto-skip-$version.zip ($size KB)"
