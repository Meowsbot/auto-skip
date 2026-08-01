# Builds dist/auto-skip-<version>.zip, containing only the files the browser
# needs. Run tests first; refuse to package a failing build.
#
#   pwsh ./package.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

node test/selftest.js
if ($LASTEXITCODE -ne 0) { throw 'Tests failed - not packaging.' }

$manifest = Get-Content manifest.json -Raw | ConvertFrom-Json
$version = $manifest.version
$staging = Join-Path $env:TEMP "auto-skip-$version"
$dist = Join-Path $PSScriptRoot 'dist'
$zip = Join-Path $dist "auto-skip-$version.zip"

# Every match pattern in sites.js must be declared in host_permissions, or that
# service can never run - the content script registration would be rejected.
$declared = [System.Collections.Generic.HashSet[string]]::new()
foreach ($pattern in $manifest.host_permissions) { [void]$declared.Add($pattern) }
$needed = node -e "for (const s of require('./sites.js').SITES) for (const m of s.matches) console.log(m)"
if ($LASTEXITCODE -ne 0) { throw 'Could not read sites.js.' }
$missing = @($needed | Where-Object { -not $declared.Contains($_) })
if ($missing.Count -gt 0) {
  throw "sites.js match patterns missing from manifest host_permissions: $($missing -join ', ')"
}

# The reverse, too: a pattern granted at install that no service uses is host
# access asked for and never used.
$used = [System.Collections.Generic.HashSet[string]]::new()
foreach ($pattern in $needed) { [void]$used.Add($pattern) }
$unused = @($manifest.host_permissions | Where-Object { -not $used.Contains($_) })
if ($unused.Count -gt 0) {
  throw "manifest host_permissions not used by any service in sites.js: $($unused -join ', ')"
}

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force $staging | Out-Null
New-Item -ItemType Directory -Force $dist | Out-Null

# Everything the extension loads at runtime, and nothing else.
$files = @(
  'manifest.json',
  'background.js',
  'sites.js',
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
Write-Output "Packaged v$version -> dist/auto-skip-$version.zip ($size KB)"
