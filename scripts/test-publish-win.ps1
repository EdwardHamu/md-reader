# Offline tests of the actual publisher control flow. Never invokes gh or uploads files.
param([string]$Publisher = (Join-Path $PSScriptRoot 'publish-win.ps1'))
$ErrorActionPreference = 'Stop'
$text = [IO.File]::ReadAllText($Publisher)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Gh' }, $true)
if (-not $function) { throw 'Cannot find the gh transport to replace; refusing to run tests' }
$mock = @'
function Invoke-Gh {
    param([string[]]$Arguments, [switch]$AllowNotFound)
    $s = $global:PublisherTestState
    $route = $Arguments[1]
    if ($Arguments[0] -eq 'api') {
        if ($route -like '*/releases/tags/*') {
            if (-not $s.release -or $s.release.draft) {
                if ($AllowNotFound) { return $null }
                throw 'REGRESSION: published-only tag endpoint used for a draft (HTTP 404)'
            }
            return $s.release | ConvertFrom-Json -Depth 8
        }
        if ($route -like '*/git/ref/tags/*') {
            if (-not $s.tagExists) {
                if ($AllowNotFound) { return $null }
                throw 'Unexpected missing tag'
            }
            return @{ object = @{ type = 'commit'; sha = $s.tagSha } } | ConvertTo-Json -Depth 8
        }
        if ($route -eq 'repos/demo/reader/releases?per_page=100') {
            if ($Arguments -notcontains '--paginate') { throw 'Release discovery must paginate' }
            if (-not $s.release -or $s.scenario -eq 'invisible') { return '' }
            return $s.release | ConvertTo-Json -Depth 8
        }
        if ($route -like '*/commits/*') { return @{ sha = $s.release.target_commitish } | ConvertTo-Json }
        if ($route -eq 'repos/demo/reader/releases/42') {
            $s.idReads++
            return $s.release | ConvertTo-Json -Depth 8
        }
        throw "Unexpected API route: $route"
    }
    if ($Arguments[0] -ne 'release') { throw 'Unexpected network command' }
    switch ($Arguments[1]) {
        create {
            $s.creates++
            $s.release = @{ id = 42; tag_name = $Tag; draft = $true; target_commitish = $SourceSha; assets = @(); html_url = 'https://example.invalid/release' }
            if ($s.scenario -eq 'lost-create-response') { throw 'Simulated lost create response' }
            return ''
        }
        upload {
            $s.uploads++
            $file = Get-Item -LiteralPath $Arguments[3]
            $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($s.scenario -eq 'bad-digest') { $digest = '0' * 64 }
            $s.release.assets = @(@{ name = $file.Name; size = $file.Length; state = 'uploaded'; digest = "sha256:$digest" })
            return ''
        }
        edit {
            $s.publishes++
            if ($Arguments -notcontains '--draft=false' -or $Arguments -notcontains $SourceSha) { throw 'Draft must publish at the pinned SHA' }
            $s.release.draft = $false
            $s.tagExists = $true
            $s.tagSha = $SourceSha
            return ''
        }
        default { throw "Unexpected release action: $($Arguments[1])" }
    }
}
'@
$instrumented = $text.Substring(0, $function.Extent.StartOffset) + $mock + $text.Substring($function.Extent.EndOffset)
$script = [scriptblock]::Create($instrumented)
$root = Join-Path ([IO.Path]::GetTempPath()) ('publisher-tests-' + [guid]::NewGuid().ToString('N'))
$variables = @('GITHUB_ACTIONS','RUNNER_TEMP','GITHUB_RUN_ID','GITHUB_STEP_SUMMARY','GH_HOST','GH_PROMPT_DISABLED')
$saved = @{}
foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
New-Item -ItemType Directory -Path $root | Out-Null
Push-Location $root
try {
    $env:GITHUB_ACTIONS = 'true'
    $env:RUNNER_TEMP = $root
    $env:GITHUB_RUN_ID = 'offline-test'
    $env:GITHUB_STEP_SUMMARY = Join-Path $root 'summary.txt'
    $bundle = 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis'
    New-Item -ItemType Directory -Path $bundle -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path (Get-Location) "$bundle/fixture.exe"), [byte[]](1,2,3,4))
    $sha = 'a' * 40
    foreach ($scenario in @('new','existing-draft','existing-published','lost-create-response','tag-conflict','draft-conflict','bad-digest','invisible')) {
        $state = @{ scenario=$scenario; tagExists=$false; tagSha=$sha; release=$null; creates=0; uploads=0; publishes=0; idReads=0 }
        if ($scenario -in @('existing-draft','existing-published','tag-conflict','draft-conflict')) {
            $state.release = @{ id=42; tag_name='v0.3.10-win.1'; draft=($scenario -ne 'existing-published'); target_commitish=$sha; assets=@(); html_url='https://example.invalid/release' }
            if ($scenario -in @('existing-published','tag-conflict')) { $state.tagExists = $true }
            if ($scenario -eq 'tag-conflict') { $state.tagSha = 'b' * 40 }
            if ($scenario -eq 'draft-conflict') { $state.release.target_commitish = 'b' * 40 }
        }
        $global:PublisherTestState = $state
        $caught = $null
        try { & $script -Repository demo/reader -Tag v0.3.10-win.1 -SourceSha $sha | Out-Null }
        catch { $caught = $_.Exception.Message }
        $expectedError = switch ($scenario) {
            tag-conflict { 'Existing tag points to different source' }
            draft-conflict { 'Existing draft targets different source' }
            bad-digest { 'Uploaded asset SHA256 mismatch' }
            invisible { 'was not visible in the authenticated release list' }
            default { $null }
        }
        if ($expectedError) {
            if (-not $caught -or -not $caught.Contains($expectedError)) { throw "FAIL ${scenario}: expected '$expectedError', got '$caught'" }
            if ($state.publishes -ne 0) { throw "FAIL ${scenario}: must not publish" }
            if ($scenario -ne 'bad-digest' -and $state.uploads -ne 0) { throw "FAIL ${scenario}: must not upload" }
        } else {
            if ($caught) { throw "FAIL ${scenario}: $caught" }
            if ($state.uploads -ne 1 -or $state.idReads -lt 2 -or $state.release.draft) { throw "FAIL ${scenario}: incomplete publication" }
            $expectedCreates = if ($scenario -in @('new','lost-create-response')) { 1 } else { 0 }
            if ($state.creates -ne $expectedCreates) { throw "FAIL ${scenario}: duplicate/missing creation" }
            $expectedPublishes = if ($scenario -eq 'existing-published') { 0 } else { 1 }
            if ($state.publishes -ne $expectedPublishes) { throw "FAIL ${scenario}: unexpected publish count" }
        }
        Write-Host "PASS $scenario"
    }
    Write-Host '8/8 publisher flow tests passed; no GitHub requests were made.'
} finally {
    Pop-Location
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    Remove-Variable -Name PublisherTestState -Scope Global -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force
}
