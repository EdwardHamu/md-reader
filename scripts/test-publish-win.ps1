# Real REST transport integration tests against a loopback-only HTTP server.
param([string]$Publisher = (Join-Path $PSScriptRoot 'publish-win.ps1'))
$ErrorActionPreference = 'Stop'
$previous = $env:PUBLISHER_TEST_POWERSHELL
try {
    # Use this same PowerShell edition: pwsh 7 on CI, installed Windows PowerShell locally.
    $env:PUBLISHER_TEST_POWERSHELL = (Get-Process -Id $PID).Path
    & node (Join-Path $PSScriptRoot 'test-publish-win-http.mjs') $Publisher
    if ($LASTEXITCODE -ne 0) { throw 'Publisher HTTP integration tests failed' }
} finally { $env:PUBLISHER_TEST_POWERSHELL = $previous }
