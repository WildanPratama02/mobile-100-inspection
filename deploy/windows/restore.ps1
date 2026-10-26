<#
.SYNOPSIS
  Restore test, or recovery of a lost server, from a nightly backup (doc 03 section 7.6, T4.1).

.DESCRIPTION
  Restore test (default; at the start of the pilot and then every quarter, ideally on another machine): restores the
  backup's dump into a new scratch database, compares the submission and photo-row counts with the backup's
  manifest, checks that every photo row has its file in the backup's photo copy and opens a sample of them, then
  drops the scratch database (-Keep leaves it). Needs PostgreSQL 16, Node.js 22 and an unpacked release; run this
  script from that release's deploy\windows folder. Changes nothing else.

  Recovery (-Full, on the M100 server after install.ps1): stops the services, puts the backup's .env, secrets and
  Caddy data in place (the replaced files are kept as *.before-restore), sets the role passwords of that .env again
  (db:bootstrap), replaces the database with the dump, copies the photos back, runs db:migrate and starts the
  services. The tablets keep working offline meanwhile and send when it is back.

  The PostgreSQL superuser password is asked at a hidden prompt and never written to a file.

.EXAMPLE
  .\restore.ps1 -From E:\m100-backup\daily\2026-11-02_010000 -PgBin 'C:\Program Files\PostgreSQL\16\bin'
.EXAMPLE
  .\restore.ps1 -From E:\m100-backup\daily\2026-11-02_010000 -Full
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $From,
    # Scratch database of the restore test.
    [string] $Database = ('m100_restore_' + (Get-Date -Format 'yyyyMMdd_HHmmss')),
    [switch] $Keep,
    [switch] $Full,
    # The PostgreSQL bin folder (pg_restore); from install.json on the server.
    [string] $PgBin,
    [int] $PgPort = 5432,
    [string] $Node = 'node.exe',
    [string] $Root
)

. (Join-Path $PSScriptRoot 'common.ps1')
$From = [IO.Path]::GetFullPath($From)
$manifestFile = Join-Path $From 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile)) { throw "$manifestFile not found: -From must be one backup folder, e.g. <backup>\daily\2026-11-02_010000" }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$photos = Join-Path (Split-Path -Parent (Split-Path -Parent $From)) 'photos'
$release = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$restoreJs = Join-Path $release 'api\dist\cli\backup-restore.js'
if (-not (Test-Path -LiteralPath $restoreJs)) { throw "$restoreJs not found: run this script from an unpacked release" }

$settings = $null
if ($Full) {
    Assert-Administrator
    if (-not $Root) { $Root = Find-InstallRoot $PSScriptRoot }
    $settings = Read-InstallSettings $Root
    $Node = $settings.Node
    if (-not $PgBin) { $PgBin = $settings.PostgresBin }
    $PgPort = $settings.PostgresPort
}

$superPassword = ConvertFrom-SecureText (Read-Host -AsSecureString "Password of the PostgreSQL superuser 'postgres'")
$env:ADMIN_DATABASE_URL = Get-AdminDatabaseUrl $superPassword $PgPort
if ($PgBin) { $env:PG_BIN = $PgBin }

function Invoke-Restore([string[]] $Arguments) {
    & $Node $restoreJs @Arguments
    if ($LASTEXITCODE -ne 0) { throw "backup:restore exited with $LASTEXITCODE" }
}

try {
    if (-not $Full) {
        Write-Step "Restore test of $($manifest.name) into the scratch database $Database"
        # A working folder without .env, so nothing of an installation on this machine is read.
        $work = Join-Path ([IO.Path]::GetTempPath()) ('m100-restore-' + [Guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $work
        Push-Location -LiteralPath $work
        try {
            $restoreArgs = @('--from', $From, '--database', $Database, '--photos', $photos)
            if ($Keep) { $restoreArgs += '--keep' }
            Invoke-Restore $restoreArgs
        } finally {
            Pop-Location
            Remove-Item -LiteralPath $work -Recurse -Force
        }
        exit 0
    }

    Write-Host "Recovery replaces the M100 database and configuration on this server with backup $($manifest.name)." -ForegroundColor Yellow
    if ((Read-Host 'Type RESTORE to continue') -ne 'RESTORE') { throw 'Cancelled' }

    Write-Step 'Stop the services'
    Stop-M100Services

    Write-Step 'Configuration from the backup (.env, secrets, caddy-data)'
    foreach ($entry in @('.env', 'secrets', 'caddy-data')) {
        $source = Join-Path $From "config\$entry"
        if (-not (Test-Path -LiteralPath $source)) { Write-Warning "The backup has no $entry"; continue }
        $target = Join-Path $Root $entry
        if (Test-Path -LiteralPath $target) {
            $aside = "$target.before-restore"
            if (Test-Path -LiteralPath $aside) { Remove-Item -LiteralPath $aside -Recurse -Force }
            Move-Item -LiteralPath $target -Destination $aside
        }
        Copy-Item -LiteralPath $source -Destination $target -Recurse
    }
    # Copied files take the folder's permissions again (secrets: API only, doc 03 section 6).
    & icacls.exe (Join-Path $Root 'secrets') /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' 'NT SERVICE\m100-api:(OI)(CI)RX' | Out-Null
    & icacls.exe (Join-Path $Root 'caddy-data') /grant:r 'NT SERVICE\m100-caddy:(OI)(CI)M' | Out-Null

    $current = Join-Path $Root 'current'
    $envValues = Read-DotEnv (Join-Path $Root '.env')
    $databaseName = ([Uri]$envValues['MIGRATE_DATABASE_URL']).AbsolutePath.TrimStart('/')

    Write-Step 'Role passwords of the restored .env (db:bootstrap)'
    $reportFile = Join-Path $Root 'secrets\report-db-password.txt'
    if (Test-Path -LiteralPath $reportFile) { $env:REPORT_DB_PASSWORD = ([IO.File]::ReadAllText($reportFile)).Trim() }
    Invoke-Cli $settings $current 'db-bootstrap'

    Write-Step "Database $databaseName from the dump"
    Push-Location -LiteralPath $Root
    try {
        Invoke-Restore @('--from', $From, '--database', $databaseName, '--photos', $photos, '--replace')
    } finally {
        Pop-Location
    }

    Write-Step 'Photos back into PHOTO_DIR'
    $photoDir = $envValues['PHOTO_DIR']
    if ($manifest.photos -eq 'mirrored' -and $photoDir) {
        & robocopy.exe $photos $photoDir /E /XO /R:2 /W:5 /NP /NFL /NDL | Out-Host
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }
        & icacls.exe $photoDir /grant:r 'NT SERVICE\m100-api:(OI)(CI)M' | Out-Null
    } else {
        Write-Warning 'The backup holds no photo copy (S3 store): restore the bucket separately'
    }

    Write-Step 'db:migrate and start'
    Invoke-Cli $settings $current 'db-migrate'
    Start-M100Services $settings
    Write-Host "Recovered from $($manifest.name)." -ForegroundColor Green
} finally {
    Remove-Item Env:\ADMIN_DATABASE_URL, Env:\REPORT_DB_PASSWORD, Env:\PG_BIN -ErrorAction SilentlyContinue
}
