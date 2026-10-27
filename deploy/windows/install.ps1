<#
.SYNOPSIS
  Installs M100 on a Windows server (doc 03 section 7, T4.1). Safe to run again: every step checks first.

.DESCRIPTION
  Steps: pre-checks; folders; Node.js 22 (MSI) if missing; PostgreSQL 16 (EDB installer, unattended) if its
  service is missing, then listening on 127.0.0.1 only; the release into releases\<version> with the junction
  `current`; .env (generated once: random role passwords, the Cloudflare token typed at a hidden prompt) and
  secrets\jwt.key; db:bootstrap and db:migrate; Caddy and the WinSW services m100-api (after PostgreSQL) and
  m100-caddy under their own virtual accounts; folder permissions; the firewall rule for port 443; the event-log
  source M100; the scheduled task "M100 nightly" (backup); start and health check.

  The installers are downloaded beforehand and passed in (no download URLs in this script):
    -NodeMsi            node-v22.x.y-x64.msi from nodejs.org (LTS)
    -PostgresInstaller  postgresql-16.x-windows-x64.exe from EnterpriseDB
    -CaddyExe           caddy.exe for windows/amd64 WITH the module github.com/caddy-dns/cloudflare
    -WinSWExe           WinSW-x64.exe 2.12.0 from github.com/winsw/winsw/releases

  The PostgreSQL superuser password is asked at a hidden prompt and never written to a file. Keep it with QIP
  Digital only (doc 03 section 6).

.EXAMPLE
  .\install.ps1 -Release D:\setup\m100-2026.11.02-ab12cd3.zip -BackupDir E:\m100-backup `
    -AllowedSubnets 192.168.43.0/24 -NodeMsi D:\setup\node-v22.20.0-x64.msi `
    -PostgresInstaller D:\setup\postgresql-16.10-1-windows-x64.exe -CaddyExe D:\setup\caddy.exe `
    -WinSWExe D:\setup\WinSW-x64.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Release,
    [Parameter(Mandatory = $true)] [string] $BackupDir,
    # Networks of the tablets and admins allowed to reach port 443, e.g. 192.168.43.0/24.
    [Parameter(Mandatory = $true)] [string[]] $AllowedSubnets,
    [string] $Root = 'C:\m100',
    [string] $PublicHost = 'm100.qdms.web.id',
    [string] $NodeMsi,
    [string] $PostgresInstaller,
    [string] $CaddyExe,
    [string] $WinSWExe,
    [string] $PostgresService = 'postgresql-x64-16',
    [string] $PostgresDir = 'C:\Program Files\PostgreSQL\16',
    [string] $PostgresDataDir,
    [int] $PostgresPort = 5432,
    [string] $Database = 'm100',
    # Daily start of the nightly backup, outside every shift.
    [string] $BackupTime = '01:00',
    [switch] $SkipPrecheck
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$Root = [IO.Path]::GetFullPath($Root)
if (-not $PostgresDataDir) { $PostgresDataDir = Join-Path $PostgresDir 'data' }

if (-not $SkipPrecheck) {
    Write-Step 'Pre-checks (doc 03 section 7.3)'
    & (Join-Path $PSScriptRoot 'precheck.ps1') -Root $Root -BackupDir $BackupDir -PublicHost $PublicHost
    if ($LASTEXITCODE -ne 0) { throw 'A pre-check failed. Fix it, or run again with -SkipPrecheck if you accept it.' }
}

Write-Step "Folders under $Root"
foreach ($dir in @('', 'releases', 'services', 'caddy', 'caddy-data', 'caddy-config', 'logs', 'photos', 'secrets')) {
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir)
}

Write-Step 'Node.js 22'
function Get-NodePath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source } else { return $null }
}
$node = Get-NodePath
if (-not $node) {
    if (-not $NodeMsi) { throw 'Node.js is not installed: pass -NodeMsi <node-v22.x.y-x64.msi>' }
    $msi = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', "`"$NodeMsi`"", '/qn', '/norestart') -Wait -PassThru
    if ($msi.ExitCode -notin @(0, 3010)) { throw "The Node.js installer failed with $($msi.ExitCode)" }
    $node = Get-NodePath
    if (-not $node) { throw 'node.exe still not found after the installation' }
}
$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -notmatch '^v22\.') { throw "Node.js $nodeVersion found at $node; M100 needs Node.js 22 LTS" }
Write-Host "$node $nodeVersion"

Write-Step 'PostgreSQL 16'
$superPassword = $null
function Get-SuperPassword {
    if (-not $script:superPassword) {
        $secure = Read-Host -AsSecureString "Password of the PostgreSQL superuser 'postgres'"
        $script:superPassword = ConvertFrom-SecureText $secure
        if (-not $script:superPassword) { throw 'An empty password is not allowed' }
    }
    return $script:superPassword
}
if (-not (Get-Service -Name $PostgresService -ErrorAction SilentlyContinue)) {
    if (-not $PostgresInstaller) { throw "Service $PostgresService not found: pass -PostgresInstaller <postgresql-16.x-windows-x64.exe>" }
    Write-Host 'Choose the superuser password now; it is used for the installation and kept by QIP Digital only.'
    $first = Get-SuperPassword
    $again = ConvertFrom-SecureText (Read-Host -AsSecureString 'Type it again')
    if ($first -ne $again) { throw 'The two passwords differ' }
    $pgArgs = @(
        '--mode', 'unattended', '--unattendedmodeui', 'none',
        '--superaccount', 'postgres', '--superpassword', $first,
        '--servicename', $PostgresService, '--serverport', "$PostgresPort",
        '--prefix', "`"$PostgresDir`"", '--datadir', "`"$PostgresDataDir`"",
        '--disable-components', 'pgAdmin,stackbuilder'
    )
    $pg = Start-Process -FilePath $PostgresInstaller -ArgumentList $pgArgs -Wait -PassThru
    if ($pg.ExitCode -ne 0) { throw "The PostgreSQL installer failed with $($pg.ExitCode)" }
}
# Only the API on this machine connects (doc 03 section 7.1): listen on loopback.
$conf = Join-Path $PostgresDataDir 'postgresql.conf'
if (Test-Path -LiteralPath $conf) {
    $text = [IO.File]::ReadAllText($conf)
    $wanted = "listen_addresses = '127.0.0.1'"
    if ($text -notmatch "(?m)^listen_addresses\s*=\s*'127\.0\.0\.1'") {
        $text = [regex]::Replace($text, "(?m)^#?\s*listen_addresses\s*=.*$", $wanted)
        if ($text -notmatch [regex]::Escape($wanted)) { $text += "`n$wanted`n" }
        [IO.File]::WriteAllText($conf, $text)
        Restart-Service -Name $PostgresService -Force
    }
} else {
    Write-Warning "$conf not found: set listen_addresses = '127.0.0.1' by hand"
}
Set-Service -Name $PostgresService -StartupType Automatic
Start-Service -Name $PostgresService
$pgBin = Join-Path $PostgresDir 'bin'
foreach ($rule in @(Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq "$PostgresPort" })) {
    $fw = $rule | Get-NetFirewallRule
    if ($fw.Enabled -eq 'True' -and $fw.Direction -eq 'Inbound' -and $fw.Action -eq 'Allow') {
        Write-Warning "Firewall rule '$($fw.DisplayName)' opens port $PostgresPort; disable it (doc 03 section 7.3)"
    }
}

Write-Step "Release $Release"
$releaseDir = Expand-Release $Release $Root
$current = Join-Path $Root 'current'
if (-not (Get-JunctionTarget $current)) { Set-Junction $current $releaseDir }
Write-Host "current -> $(Get-JunctionTarget $current)"

$settings = @{
    Root            = $Root
    Node            = $node
    PostgresService = $PostgresService
    PostgresBin     = $pgBin
    PostgresPort    = $PostgresPort
    PublicHost      = $PublicHost
    BackupDir       = $BackupDir
}
Write-InstallSettings $Root $settings
$settings = Read-InstallSettings $Root

Write-Step 'Configuration (.env, secrets)'
$envFile = Join-Path $Root '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    $token = ConvertFrom-SecureText (Read-Host -AsSecureString 'Cloudflare API token (Zone Read + DNS Edit on the zone only)')
    if (-not $token) { throw 'The Cloudflare token is needed for the certificate (doc 03 section 7.2.1)' }
    $appPassword = New-RandomSecret
    $migratePassword = New-RandomSecret
    Write-TextFile $envFile @(
        '# M100 configuration (doc 03 section 7.4). Readable by the services and administrators only.',
        "DATABASE_URL=postgres://m100_app:$appPassword@127.0.0.1:$PostgresPort/$Database",
        "MIGRATE_DATABASE_URL=postgres://m100_migrate:$migratePassword@127.0.0.1:$PostgresPort/$Database",
        'PHOTO_STORE=disk',
        "PHOTO_DIR=$(Join-Path $Root 'photos')",
        'JWT_KEY_FILE=secrets\jwt.key',
        "PUBLIC_HOST=$PublicHost",
        "CF_API_TOKEN=$token",
        'TZ=Asia/Jakarta',
        'LOG_LEVEL=info',
        'NODE_ENV=production',
        "BACKUP_DIR=$BackupDir",
        "PG_BIN=$pgBin"
    )
    Write-Host "Wrote $envFile"
} else {
    Write-Host "$envFile exists; kept as it is"
}
$jwtKey = Join-Path $Root 'secrets\jwt.key'
if (-not (Test-Path -LiteralPath $jwtKey)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [IO.File]::WriteAllBytes($jwtKey, $bytes)
    Write-Host "Wrote $jwtKey"
}

Write-Step 'Database roles and schema (db:bootstrap, db:migrate)'
$reportFile = Join-Path $Root 'secrets\report-db-password.txt'
if (-not (Test-Path -LiteralPath $reportFile)) { Write-TextFile $reportFile @(New-RandomSecret) }
# The superuser URL and the report password reach db:bootstrap through this process only, never .env.
$env:ADMIN_DATABASE_URL = Get-AdminDatabaseUrl (Get-SuperPassword) $PostgresPort
$env:REPORT_DB_PASSWORD = ([IO.File]::ReadAllText($reportFile)).Trim()
try {
    Invoke-Cli $settings $current 'db-bootstrap'
} finally {
    Remove-Item Env:\ADMIN_DATABASE_URL, Env:\REPORT_DB_PASSWORD -ErrorAction SilentlyContinue
}
Invoke-Cli $settings $current 'db-migrate'

Write-Step 'Caddy and WinSW'
$caddy = Join-Path $Root 'caddy\caddy.exe'
if ($CaddyExe) { Copy-Item -LiteralPath $CaddyExe -Destination $caddy -Force }
if (-not (Test-Path -LiteralPath $caddy)) { throw 'Caddy is not installed: pass -CaddyExe <caddy.exe with the cloudflare module>' }
$modules = (& $caddy list-modules) -join "`n"
if ($modules -notmatch 'dns\.providers\.cloudflare') {
    throw "$caddy has no Cloudflare DNS module: download it with github.com/caddy-dns/cloudflare (doc 03 section 7.2.1 step 6)"
}
foreach ($name in $script:Services) {
    $exe = Join-Path $Root "services\$name.exe"
    if ($WinSWExe) { Copy-Item -LiteralPath $WinSWExe -Destination $exe -Force }
    if (-not (Test-Path -LiteralPath $exe)) { throw 'WinSW is not installed: pass -WinSWExe <WinSW-x64.exe>' }
}
Stop-M100Services
Write-ServiceDefinitions $settings $current
foreach ($name in $script:Services) {
    $exe = Join-Path $Root "services\$name.exe"
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
        & $exe uninstall
        if ($LASTEXITCODE -ne 0) { throw "WinSW could not remove $name" }
    }
    & $exe install
    if ($LASTEXITCODE -ne 0) { throw "WinSW could not install $name" }
    # A virtual account per service: no password to keep, rights only where granted below (doc 03 section 7.3).
    & sc.exe config $name obj= "NT SERVICE\$name" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe could not set the account of $name" }
}

Write-Step 'Permissions'
$api = 'NT SERVICE\m100-api'
$caddyAccount = 'NT SERVICE\m100-caddy'
function Grant-Access([string] $Path, [string[]] $Grants, [switch] $Replace) {
    $icaclsArgs = @($Path)
    if ($Replace) { $icaclsArgs += '/inheritance:r' }
    foreach ($g in $Grants) { $icaclsArgs += @('/grant:r', $g) }
    & icacls.exe @icaclsArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Path" }
}
# Administrators and SYSTEM full control everywhere; the services read the install folder (releases, .env).
Grant-Access $Root -Replace @('*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', "${api}:(OI)(CI)RX", "${caddyAccount}:(OI)(CI)RX")
Grant-Access (Join-Path $Root 'logs') @("${api}:(OI)(CI)M", "${caddyAccount}:(OI)(CI)M")
Grant-Access (Join-Path $Root 'photos') @("${api}:(OI)(CI)M")
Grant-Access (Join-Path $Root 'caddy-data') @("${caddyAccount}:(OI)(CI)M")
Grant-Access (Join-Path $Root 'caddy-config') @("${caddyAccount}:(OI)(CI)M")
# Secrets: the API only (jwt.key); Caddy never.
Grant-Access (Join-Path $Root 'secrets') -Replace @('*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', "${api}:(OI)(CI)RX")
Grant-Access $reportFile -Replace @('*S-1-5-32-544:F', '*S-1-5-18:F')

Write-Step 'Firewall: TCP 443 from the tablet and admin networks only'
Get-NetFirewallRule -Name 'M100-HTTPS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$null = New-NetFirewallRule -Name 'M100-HTTPS' -DisplayName 'M100 HTTPS (Caddy)' -Direction Inbound -Protocol TCP `
    -LocalPort 443 -RemoteAddress $AllowedSubnets -Action Allow -Profile Any

Write-Step 'Event log source and nightly task'
if (-not [Diagnostics.EventLog]::SourceExists('M100')) { New-EventLog -LogName Application -Source 'M100' }
$m100 = Join-Path $current 'deploy\windows\m100.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$m100`" nightly"
$trigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$null = Register-ScheduledTask -TaskName 'M100 nightly' -Action $action -Trigger $trigger -Principal $principal `
    -Settings $taskSettings -Description 'M100 backup (pg_dump, photos, configuration) and log cleanup; doc 03 section 7.6' -Force

Write-Step 'Start: PostgreSQL, API, Caddy'
Start-M100Services $settings
Write-Host 'API healthy on 127.0.0.1:3000.'
try {
    Wait-Health "https://$PublicHost/v1/health" 120
    Write-Host "https://$PublicHost/v1/health answers 200." -ForegroundColor Green
} catch {
    Write-Warning "https://$PublicHost/v1/health does not answer yet: $($_.Exception.Message). Check the DNS record, the Cloudflare token and logs\m100-caddy*.log (doc 03 section 7.2.1)."
}

Write-Host ''
Write-Host 'Next (doc 03 section 7.4, 7.5):' -ForegroundColor Green
Write-Host "  $m100 admin:create --username admin"
Write-Host "  $m100 import-master --dir <folder of the exports>"
Write-Host "  $m100 device:add --label `"Tablet F3-01`""
