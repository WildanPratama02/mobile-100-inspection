# Shared helpers of install.ps1, upgrade.ps1, restore.ps1 and m100.ps1 (doc 03 section 7). Dot-source it:
#   . (Join-Path $PSScriptRoot 'common.ps1')
# Windows PowerShell 5.1 compatible. Keep this file ASCII: 5.1 reads a file without BOM in the ANSI code page.

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:SettingsFile = 'install.json'
$script:Services = @('m100-api', 'm100-caddy')

function Write-Step([string] $Text) {
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script in an elevated PowerShell (Run as administrator).'
    }
}

# The install folder: the nearest ancestor of $From that holds install.json.
function Find-InstallRoot([string] $From) {
    $dir = $From
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir $script:SettingsFile)) { return $dir }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    throw "No $($script:SettingsFile) above $From. Pass -Root, or run install.ps1 first."
}

function Read-InstallSettings([string] $Root) {
    $path = Join-Path $Root $script:SettingsFile
    if (-not (Test-Path -LiteralPath $path)) { throw "$path not found. Run install.ps1 first." }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Write-InstallSettings([string] $Root, [hashtable] $Settings) {
    $json = $Settings | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $Root $script:SettingsFile), $json + "`n", (New-Object Text.UTF8Encoding($false)))
}

# KEY=VALUE lines of a .env file as a hashtable (comments and blank lines skipped, no quote handling: the
# scripts never write quotes).
function Read-DotEnv([string] $Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $values[$trimmed.Substring(0, $eq).Trim()] = $trimmed.Substring($eq + 1).Trim()
    }
    return $values
}

# Writes lines as UTF-8 without BOM and LF endings (Node's .env parser and Caddy's --envfile both read it).
function Write-TextFile([string] $Path, [string[]] $Lines) {
    [IO.File]::WriteAllText($Path, ($Lines -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
}

# A random secret of letters and digits: safe inside a postgres:// URL and a .env line without quoting.
function New-RandomSecret([int] $Length = 32) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $bytes = New-Object byte[] $Length
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $chars = foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
    return -join $chars
}

function ConvertFrom-SecureText([Security.SecureString] $Secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# The superuser URL for db:bootstrap and backup:restore; the password never reaches a file.
function Get-AdminDatabaseUrl([string] $Password, [int] $Port = 5432, [string] $User = 'postgres') {
    return 'postgres://{0}:{1}@127.0.0.1:{2}/postgres' -f $User, [Uri]::EscapeDataString($Password), $Port
}

function Test-Junction([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# The release folder name `current` points to, or $null.
function Get-JunctionTarget([string] $Path) {
    if (-not (Test-Junction $Path)) { return $null }
    $target = (Get-Item -LiteralPath $Path -Force).Target
    if ($target -is [array]) { $target = $target[0] }
    return $target
}

# Points the junction $Path at $Target. Removes only the link, never the folder it points to (Remove-Item on a
# junction in PowerShell 5.1 can delete the target's contents).
function Set-Junction([string] $Path, [string] $Target) {
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) { throw "$Target is not a folder" }
    if (Test-Path -LiteralPath $Path) {
        if (-not (Test-Junction $Path)) { throw "$Path exists and is not a junction; not touching it" }
        [IO.Directory]::Delete($Path, $false)
    }
    $null = New-Item -ItemType Junction -Path $Path -Value $Target
}

# Unpacks a release zip into <Root>\releases\<version> and returns that folder. The version is the zip's VERSION
# file. A release already unpacked is reused.
function Expand-Release([string] $Zip, [string] $Root) {
    if (-not (Test-Path -LiteralPath $Zip -PathType Leaf)) { throw "Release $Zip not found" }
    $releases = Join-Path $Root 'releases'
    $null = New-Item -ItemType Directory -Force -Path $releases
    $staging = Join-Path $releases ('.staging-' + [Guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $Zip -DestinationPath $staging
        $versionFile = Join-Path $staging 'VERSION'
        if (-not (Test-Path -LiteralPath $versionFile)) { throw "$Zip has no VERSION file: not an m100 release" }
        $version = ([IO.File]::ReadAllText($versionFile)).Trim()
        if ($version -notmatch '^[0-9A-Za-z.\-]+$') { throw "Unexpected release version '$version'" }
        $folder = Join-Path $releases $version
        if (Test-Path -LiteralPath $folder) {
            Write-Host "Release $version is already unpacked; using $folder"
        } else {
            Move-Item -LiteralPath $staging -Destination $folder
        }
        return $folder
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }
}

# Fills the {{...}} values of a WinSW template.
function Format-ServiceXml([string] $Template, [hashtable] $Values) {
    $text = [IO.File]::ReadAllText($Template)
    foreach ($key in $Values.Keys) { $text = $text.Replace('{{' + $key + '}}', [string] $Values[$key]) }
    if ($text -match '\{\{[A-Z_]+\}\}') { throw "$Template still has the placeholder $($Matches[0])" }
    return $text
}

function Get-ServiceXmlValues($Settings) {
    return @{
        ROOT             = $Settings.Root
        ROOT_SLASHED     = $Settings.Root.Replace('\', '/')
        NODE             = $Settings.Node
        POSTGRES_SERVICE = $Settings.PostgresService
    }
}

# Writes services\<name>.xml from the templates of the release in $ReleaseDir.
function Write-ServiceDefinitions($Settings, [string] $ReleaseDir) {
    $values = Get-ServiceXmlValues $Settings
    foreach ($name in $script:Services) {
        $xml = Format-ServiceXml (Join-Path $ReleaseDir "deploy\windows\$name.xml") $values
        Write-TextFile (Join-Path $Settings.Root "services\$name.xml") @($xml.TrimEnd())
    }
}

# Runs `node <release>\api\dist\cli\<Script>.js` in the install folder (where .env is); throws on a non-zero exit.
function Invoke-Cli($Settings, [string] $ReleaseDir, [string] $Script, [string[]] $Arguments = @()) {
    $js = Join-Path $ReleaseDir "api\dist\cli\$Script.js"
    if (-not (Test-Path -LiteralPath $js)) { throw "$js not found" }
    Push-Location -LiteralPath $Settings.Root
    try {
        & $Settings.Node $js @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Script exited with $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# Waits until GET <Url> answers 200, or throws after $Seconds.
function Wait-Health([string] $Url = 'http://127.0.0.1:3000/v1/health', [int] $Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $last = ''
    while ((Get-Date) -lt $deadline) {
        try {
            $answer = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($answer.StatusCode -eq 200) { return }
            $last = "HTTP $($answer.StatusCode)"
        } catch {
            $last = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }
    throw "$Url did not answer 200 within $Seconds s (last: $last)"
}

# A code-only switch cannot remove an applied migration. Require the same migration
# files and hashes for automatic/manual rollback; unknown compatibility fails closed.
function Assert-CodeRollbackCompatible([string] $From, [string] $To) {
    $fromMigrations = Join-Path $From 'db\migrations'
    $toMigrations = Join-Path $To 'db\migrations'
    foreach ($path in @($fromMigrations, $toMigrations)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw 'Cannot establish rollback compatibility: migration directory missing. Use the recovery runbook.'
        }
    }
    $source = @(Get-ChildItem -LiteralPath $fromMigrations -Filter '*.sql' -File | Sort-Object Name)
    $target = @(Get-ChildItem -LiteralPath $toMigrations -Filter '*.sql' -File | Sort-Object Name)
    if ($source.Count -eq 0 -or $source.Count -ne $target.Count) {
        throw 'Code-only rollback blocked across a migration boundary. Use forward recovery or coordinated restore.'
    }
    for ($i = 0; $i -lt $source.Count; $i++) {
        if ($source[$i].Name -ne $target[$i].Name -or
            (Get-FileHash -LiteralPath $source[$i].FullName -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $target[$i].FullName -Algorithm SHA256).Hash) {
            throw 'Code-only rollback blocked: migration histories differ. Use forward recovery or coordinated restore.'
        }
    }
}

function Stop-M100Services {
    foreach ($name in @('m100-caddy', 'm100-api')) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) { Stop-Service -Name $name -Force }
    }
}

# PostgreSQL first, then the API (checked by its health), then Caddy (doc 03 section 7.1).
function Start-M100Services($Settings) {
    Start-Service -Name $Settings.PostgresService
    Start-Service -Name 'm100-api'
    Wait-Health
    Start-Service -Name 'm100-caddy'
}

# Release folders, most recently unpacked first, without the .staging leftovers.
function Get-ReleaseFolders([string] $Root) {
    $releases = Join-Path $Root 'releases'
    if (-not (Test-Path -LiteralPath $releases)) { return @() }
    return @(Get-ChildItem -LiteralPath $releases -Directory | Where-Object { -not $_.Name.StartsWith('.') } |
        Sort-Object CreationTime -Descending)
}

function Write-M100Event([string] $Message, [int] $EventId, [string] $EntryType = 'Information') {
    try {
        Write-EventLog -LogName Application -Source 'M100' -EventId $EventId -EntryType $EntryType -Message $Message
    } catch {
        Write-Warning "Could not write to the event log (source M100): $($_.Exception.Message)"
    }
}
