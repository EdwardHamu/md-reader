# CI publisher: only the NSIS EXE is attached, never MSI/ZIP/macOS/Linux artifacts.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$SourceSha
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$env:GH_HOST = 'github.com'
$env:GH_PROMPT_DISABLED = '1'

if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This publisher is intended for GitHub Actions only.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
if ($SourceSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'Invalid source SHA' }
if ($Tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9][A-Za-z0-9.-]*)?$') { throw 'Invalid tag' }

function Invoke-Gh {
    param([string[]]$Arguments, [switch]$AllowNotFound)
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        # Process timeout also bounds an upload whose TCP connection stops responding.
        $info = [System.Diagnostics.ProcessStartInfo]::new('gh')
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $info
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) {
            $process.Kill($true)
            $process.WaitForExit()
            $errorText = 'gh request timed out after 180 seconds'
        } else {
            $errorText = $stderr.GetAwaiter().GetResult()
            if ($process.ExitCode -eq 0) {
                $result = $stdout.GetAwaiter().GetResult()
                $process.Dispose()
                return $result
            }
            if ($AllowNotFound -and $errorText -match 'HTTP 404') {
                $process.Dispose()
                return $null
            }
        }
        $process.Dispose()
        if ($attempt -eq 5) { throw "gh failed after $attempt attempts: $errorText" }
        Write-Warning "gh request failed ($attempt/5): $errorText"
        Start-Sleep -Seconds ([Math]::Min(30, [Math]::Pow(2, $attempt)))
    }
}

$files = @(Get-ChildItem 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe' -File)
if ($files.Count -ne 1 -or $files[0].Length -eq 0) { throw 'Expected exactly one non-empty NSIS installer EXE' }
$assetName = "MD-Reader-$Tag-windows-x64-setup.exe"
$staging = Join-Path $env:RUNNER_TEMP "md-reader-exe-$env:GITHUB_RUN_ID"
New-Item -ItemType Directory -Path $staging -Force | Out-Null
$asset = Join-Path $staging $assetName
Copy-Item -LiteralPath $files[0].FullName -Destination $asset -Force
$hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $asset).Length

# Resolve annotated tags too. Never attach new code to a tag pointing to a different commit.
function Assert-TagCommit {
    $refJson = Invoke-Gh -Arguments @('api', "repos/$Repository/git/ref/tags/$Tag") -AllowNotFound
    if ($null -eq $refJson) { return $false }
    $obj = ($refJson | ConvertFrom-Json).object
    for ($depth = 0; $obj.type -eq 'tag'; $depth++) {
        if ($depth -ge 8) { throw 'Annotated tag chain is too deep' }
        $obj = ((Invoke-Gh -Arguments @('api', "repos/$Repository/git/tags/$($obj.sha)")) | ConvertFrom-Json).object
    }
    if ($obj.type -ne 'commit' -or $obj.sha -ne $SourceSha) { throw 'Existing tag points to different source; use a new tag' }
    return $true
}
$tagExists = Assert-TagCommit
$releaseJson = Invoke-Gh -Arguments @('api', "repos/$Repository/releases/tags/$Tag") -AllowNotFound
$newRelease = $null -eq $releaseJson
if (-not $newRelease -and -not $tagExists) {
    $existing = $releaseJson | ConvertFrom-Json
    $encodedTarget = [Uri]::EscapeDataString($existing.target_commitish)
    $targetCommit = ((Invoke-Gh -Arguments @('api', "repos/$Repository/commits/$encodedTarget")) | ConvertFrom-Json).sha
    if ($targetCommit -ne $SourceSha) { throw 'Existing draft targets different source; use a new tag' }
}
if ($newRelease) {
    # A draft is left for diagnosis if upload fails; nothing incomplete is newly published.
    $notes = "Windows x64 NSIS installer only. Source: $SourceSha. SHA256 ($assetName): $hash. Unsigned installer; WebView2 is required."
    try {
        [void](Invoke-Gh -Arguments @('release', 'create', $Tag, '--repo', $Repository, '--target', $SourceSha, '--title', "MD Reader $Tag (Windows x64)", '--notes', $notes, '--draft'))
    } catch {
        # Creation can succeed remotely even if its response is lost; reconcile before failing.
        $releaseJson = Invoke-Gh -Arguments @('api', "repos/$Repository/releases/tags/$Tag") -AllowNotFound
        if ($null -eq $releaseJson) { throw }
    }
}
# Reconcile the draft target again after creation (including a lost create response).
$beforeUpload = (Invoke-Gh -Arguments @('api', "repos/$Repository/releases/tags/$Tag")) | ConvertFrom-Json
if (-not (Assert-TagCommit)) {
    $encodedTarget = [Uri]::EscapeDataString($beforeUpload.target_commitish)
    $targetCommit = ((Invoke-Gh -Arguments @('api', "repos/$Repository/commits/$encodedTarget")) | ConvertFrom-Json).sha
    if ($targetCommit -ne $SourceSha) { throw 'Draft source changed; refusing upload' }
}
[void](Invoke-Gh -Arguments @('release', 'upload', $Tag, $asset, '--repo', $Repository, '--clobber'))
$release = (Invoke-Gh -Arguments @('api', "repos/$Repository/releases/tags/$Tag")) | ConvertFrom-Json
$uploaded = @($release.assets | Where-Object { $_.name -eq $assetName })
if ($uploaded.Count -ne 1 -or $uploaded[0].size -ne $size -or $uploaded[0].state -ne 'uploaded') { throw 'Uploaded asset verification failed' }
if ($uploaded[0].digest -and $uploaded[0].digest -ne "sha256:$hash") { throw 'Uploaded asset SHA256 mismatch' }
[void](Assert-TagCommit)
# Existing releases keep their title/notes/prerelease state. Only this named EXE is replaced.
if ($release.draft) {
    [void](Invoke-Gh -Arguments @('release', 'edit', $Tag, '--repo', $Repository, '--target', $SourceSha, '--draft=false'))
}
if (-not (Assert-TagCommit)) { throw 'Published release tag is missing' }
$verified = (Invoke-Gh -Arguments @('api', "repos/$Repository/releases/tags/$Tag")) | ConvertFrom-Json
if ($verified.draft) { throw 'Release remained a draft' }
@"
## Windows x64 release
- Release: $($verified.html_url)
- Source commit: $SourceSha
- Installer: $assetName
- Bytes: $size
- SHA256: $hash
"@ | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
Write-Host "Published: $($verified.html_url)"
