# CI publisher. IDs returned by GitHub are authoritative; never rediscover a newly
# created draft through the published-only tag endpoint or a potentially stale list.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$SourceSha
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This publisher is intended for GitHub Actions only.' }
if (-not $env:GH_TOKEN) { throw 'GH_TOKEN is required' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
if ($SourceSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'Invalid source SHA' }
if ($Tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$') { throw 'Invalid tag' }
$api = "https://api.github.com/repos/$Repository"
$uploadsApi = "https://uploads.github.com/repos/$Repository"
$headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'md-reader-release-win' }

function Invoke-Api {
    param([string]$Method, [string]$Uri, $Body, [string]$File, [switch]$AllowNotFound, [int]$Attempts = 5)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $options = @{ Method=$Method; Uri=$Uri; Headers=$headers; TimeoutSec=180; ErrorAction='Stop'; UseBasicParsing=$true }
            if ($File) { $options.InFile=$File; $options.ContentType='application/octet-stream' }
            elseif ($null -ne $Body) { $options.Body=[Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress)); $options.ContentType='application/json; charset=utf-8' }
            # Materialize then emit: Invoke-RestMethod otherwise writes an array as
            # one pipeline object, breaking page counts in Windows PowerShell 5.
            $responseValue = Invoke-RestMethod @options
            return $responseValue
        } catch {
            $code = 0
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            if ($AllowNotFound -and $code -eq 404) { return $null }
            if ($attempt -eq $Attempts) { throw }
            Write-Warning "$Method $Uri failed (HTTP $code, $attempt/$Attempts); retrying"
            Start-Sleep -Seconds ([Math]::Min(30, [Math]::Pow(2, $attempt)))
        }
    }
}

function Find-Release {
    # Only discovery/reconciliation uses listing; filter decoded JSON in PowerShell,
    # not a jq expression passed through the Windows native-command argument boundary.
    for ($page = 1; ; $page++) {
        $items = @(Invoke-Api GET "$api/releases?per_page=100&page=$page")
        $matches = @($items | Where-Object { $_.tag_name -ceq $Tag })
        if ($matches.Count -gt 1) { throw 'Multiple releases match this tag; refusing to guess' }
        if ($matches.Count -eq 1) { return $matches[0] }
        if ($items.Count -lt 100) { return $null }
    }
}

function Assert-TagCommit {
    $reference = Invoke-Api GET "$api/git/ref/tags/$Tag" -AllowNotFound
    if ($null -eq $reference) { return $false }
    $obj = $reference.object
    for ($depth=0; $obj.type -eq 'tag'; $depth++) {
        if ($depth -ge 8) { throw 'Annotated tag chain is too deep' }
        $obj = (Invoke-Api GET "$api/git/tags/$($obj.sha)").object
    }
    if ($obj.type -ne 'commit' -or $obj.sha -ne $SourceSha) { throw 'Existing tag points to different source; use a new tag' }
    return $true
}

function Assert-ReleaseSource($Release) {
    if (-not $Release.id -or $Release.tag_name -cne $Tag) { throw 'Release identity mismatch' }
    if (-not (Assert-TagCommit)) {
        if (-not $Release.draft) { throw 'Published release has no tag' }
        $target = [Uri]::EscapeDataString($Release.target_commitish)
        if ((Invoke-Api GET "$api/commits/$target").sha -ne $SourceSha) { throw 'Existing draft targets different source; use a new tag' }
    }
}

$files = @(Get-ChildItem 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe' -File)
if ($files.Count -ne 1 -or $files[0].Length -eq 0) { throw 'Expected exactly one non-empty NSIS installer EXE' }
$asset = $files[0].FullName
$assetName = "MD-Reader-$Tag-windows-x64-setup.exe"
$size = $files[0].Length
$hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
[void](Assert-TagCommit)
$release = Find-Release
if ($null -eq $release) {
    $body = @{ tag_name=$Tag; target_commitish=$SourceSha; name="MD Reader $Tag (Windows x64)"; draft=$true; prerelease=$false; body="Windows x64 NSIS installer. Source: $SourceSha. SHA256 ($assetName): $hash. Unsigned; WebView2 required." }
    for ($attempt=1; $attempt -le 5; $attempt++) {
        try {
            # POST returns the draft JSON including its numeric ID. Keep that response.
            $release = Invoke-Api POST "$api/releases" -Body $body -Attempts 1
            break
        } catch {
            $creationError = $_
            # A lost response may still have created a draft. Reconcile before resending.
            for ($probe=1; $probe -le 5; $probe++) {
                $release = Find-Release
                if ($release) { break }
                if ($probe -lt 5) { Start-Sleep -Seconds ([Math]::Pow(2, $probe)) }
            }
            if ($release) { break }
            if ($attempt -eq 5) { throw $creationError }
            Write-Warning 'Draft creation failed and no matching release was found; retrying creation'
        }
    }
}
Assert-ReleaseSource $release
$releaseId = $release.id
Write-Host "Release ID: $releaseId; tag: $Tag; source: $SourceSha"
$releaseUri = "$api/releases/$releaseId"
$release = Invoke-Api GET $releaseUri
Assert-ReleaseSource $release

# Replace only the named EXE. Each retry reconciles a possibly completed upload first.
$uploaded = $null
for ($attempt=1; $attempt -le 5; $attempt++) {
    $release = Invoke-Api GET $releaseUri
    $existing = @($release.assets | Where-Object { $_.name -ceq $assetName })
    if ($existing.Count -gt 1) { throw 'Duplicate installer assets' }
    if ($existing.Count -eq 1 -and $existing[0].state -eq 'uploaded' -and $existing[0].size -eq $size -and $existing[0].digest -eq "sha256:$hash") {
        $uploaded = $existing[0]; break
    }
    foreach ($item in $existing) { [void](Invoke-Api DELETE "$api/releases/assets/$($item.id)" -AllowNotFound) }
    try {
        $uri = "$uploadsApi/releases/$releaseId/assets?name=$([Uri]::EscapeDataString($assetName))"
        $uploaded = Invoke-Api POST $uri -File $asset -Attempts 1
        break
    } catch {
        if ($attempt -eq 5) { throw }
        Write-Warning "Asset upload failed ($attempt/5); reconciling by Release ID before retry"
        Start-Sleep -Seconds ([Math]::Min(30, [Math]::Pow(2, $attempt)))
    }
}
if (-not $uploaded -or $uploaded.name -cne $assetName -or $uploaded.size -ne $size -or $uploaded.state -ne 'uploaded') { throw 'Uploaded asset verification failed' }
if ($uploaded.digest -and $uploaded.digest -ne "sha256:$hash") { throw 'Uploaded asset SHA256 mismatch' }
$release = Invoke-Api GET $releaseUri
Assert-ReleaseSource $release
if ($release.draft) {
    $release = Invoke-Api PATCH $releaseUri -Body @{ draft=$false; target_commitish=$SourceSha }
}
$verified = Invoke-Api GET $releaseUri
if ($verified.draft) { throw 'Release remained a draft' }
if ($verified.id -ne $releaseId -or $verified.tag_name -cne $Tag) { throw 'Published release identity mismatch' }
if (-not (Assert-TagCommit)) { throw 'Published release tag is missing' }
@"
## Windows x64 release
- Release: $($verified.html_url)
- Source commit: $SourceSha
- Installer: $assetName
- Bytes: $size
- SHA256: $hash
"@ | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
Write-Host "Published: $($verified.html_url)"
