<#
.SYNOPSIS
  Server pre-checks before installing M100 (doc 03 section 7.3, TQ-5). Changes nothing.

.DESCRIPTION
  Prints one line per check: PASS, WARN, FAIL or MANUAL (something to confirm by hand). Exits 1 when any check
  fails. install.ps1 runs it first; QIP Digital can run it on its own before the installation:

    powershell -ExecutionPolicy Bypass -File precheck.ps1 -BackupDir D:\m100-backup

.PARAMETER Root
  The install folder; its drive needs the free disk space.
.PARAMETER BackupDir
  Where the nightly backup goes: a folder on another disk or a share (\\server\share\m100).
.PARAMETER PublicHost
  The app's host name; its DNS record should point to this server.
.PARAMETER SkipNetwork
  Skip the outbound HTTPS checks (Cloudflare, Let's Encrypt).
#>
[CmdletBinding()]
param(
    [string] $Root = 'C:\m100',
    [string] $BackupDir,
    [string] $PublicHost = 'm100.qdms.web.id',
    [int] $MinFreeRamGB = 4,
    [int] $MinFreeDiskGB = 50,
    [switch] $SkipNetwork
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string] $Check, [string] $Status, [string] $Detail) {
    $results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
}

# Windows 10 / Server 2016 (build 14393) or newer for Node.js 22 and PostgreSQL 16.
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
Add-Result 'Windows version' $(if ($build -ge 14393) { 'PASS' } else { 'FAIL' }) "$($os.Caption) build $build"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Result 'Administrator' $(if ($isAdmin) { 'PASS' } else { 'WARN' }) $(if ($isAdmin) { 'elevated' } else { 'not elevated: install.ps1 needs Run as administrator' })

# Port 443 free (or already ours).
$listeners = @(Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
    Add-Result 'Port 443' 'PASS' 'free'
} else {
    $names = @($listeners | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Sort-Object -Unique)
    if ($names.Count -eq 1 -and $names[0] -eq 'caddy') { Add-Result 'Port 443' 'PASS' 'used by Caddy (M100 already installed)' }
    else { Add-Result 'Port 443' 'FAIL' ("in use by: " + ($names -join ', ')) }
}
$iis = Get-Service -Name 'W3SVC' -ErrorAction SilentlyContinue
if ($iis -and $iis.Status -eq 'Running') { Add-Result 'IIS' 'WARN' 'W3SVC is running; make sure it does not bind port 443' }

# Memory and disk.
$freeRamGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$totalRamGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
Add-Result 'Free RAM' $(if ($freeRamGB -ge $MinFreeRamGB) { 'PASS' } else { 'FAIL' }) "$freeRamGB GB free of $totalRamGB GB (need $MinFreeRamGB GB)"

$rootDrive = ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Root))).TrimEnd('\')
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$rootDrive'"
if ($disk) {
    $freeDiskGB = [math]::Round($disk.FreeSpace / 1GB, 1)
    Add-Result "Free disk $rootDrive" $(if ($freeDiskGB -ge $MinFreeDiskGB) { 'PASS' } else { 'FAIL' }) "$freeDiskGB GB free (need $MinFreeDiskGB GB)"
} else {
    Add-Result "Free disk $rootDrive" 'FAIL' "drive $rootDrive not found"
}

# Backup target: writable, and not the same disk as the data.
if (-not $BackupDir) {
    Add-Result 'Backup target' 'FAIL' 'not given (-BackupDir): a second disk or a network share'
} else {
    try {
        $null = New-Item -ItemType Directory -Force -Path $BackupDir
        $probe = Join-Path $BackupDir ('.m100-precheck-' + [Guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText($probe, 'probe')
        Remove-Item -LiteralPath $probe -Force
        $backupRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($BackupDir)).TrimEnd('\')
        if ($backupRoot -eq $rootDrive) {
            Add-Result 'Backup target' 'WARN' "$BackupDir is writable but on the same disk as $Root; use another disk or a share"
        } else {
            Add-Result 'Backup target' 'PASS' "$BackupDir is writable (the nightly task runs as SYSTEM: for a share, allow this computer's account)"
        }
    } catch {
        Add-Result 'Backup target' 'FAIL' "$BackupDir is not writable: $($_.Exception.Message)"
    }
}

# Time: zone and NTP (token expiry rejects a skewed clock, doc 03 section 7.1).
$tz = Get-TimeZone
Add-Result 'Time zone' $(if ($tz.Id -eq 'SE Asia Standard Time') { 'PASS' } else { 'WARN' }) "$($tz.Id) ($($tz.BaseUtcOffset)); the services use TZ=Asia/Jakarta either way"
$w32 = (& w32tm /query /status 2>&1) -join "`n"
if ($LASTEXITCODE -eq 0 -and $w32 -match 'Source:\s*(.+)') {
    $source = $Matches[1].Trim()
    $ntpOk = $source -notmatch 'Local CMOS Clock|Free-running'
    Add-Result 'NTP' $(if ($ntpOk) { 'PASS' } else { 'FAIL' }) "time source: $source"
} else {
    Add-Result 'NTP' 'FAIL' 'w32tm /query /status failed: is the Windows Time service running?'
}

# Outbound HTTPS for the certificate only (doc 03 section 7.3).
if (-not $SkipNetwork) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    foreach ($url in @('https://api.cloudflare.com/client/v4', 'https://acme-v02.api.letsencrypt.org/directory')) {
        try {
            $null = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 15
            Add-Result "Reach $(([Uri]$url).Host)" 'PASS' 'answered'
        } catch [Net.WebException] {
            # Any HTTP answer (also 4xx) proves the connection works.
            if ($_.Exception.Response) { Add-Result "Reach $(([Uri]$url).Host)" 'PASS' "answered HTTP $([int]$_.Exception.Response.StatusCode)" }
            else { Add-Result "Reach $(([Uri]$url).Host)" 'FAIL' $_.Exception.Message }
        }
    }
}

# Address: the DNS record should point to this server; a DHCP address needs a reservation.
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })
$ipList = ($addresses | ForEach-Object { $_.IPAddress }) -join ', '
try {
    $resolved = @(Resolve-DnsName -Name $PublicHost -Type A -ErrorAction Stop | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress })
    $match = @($resolved | Where-Object { $ipList -split ', ' -contains $_ })
    Add-Result "DNS $PublicHost" $(if ($match.Count -gt 0) { 'PASS' } else { 'WARN' }) ("resolves to " + ($resolved -join ', ') + "; this server has $ipList")
} catch {
    Add-Result "DNS $PublicHost" 'WARN' "does not resolve yet (doc 03 section 7.2.1 step 4); this server has $ipList"
}
$dhcp = @($addresses | Where-Object { $_.PrefixOrigin -eq 'Dhcp' })
if ($dhcp.Count -gt 0) {
    Add-Result 'Fixed address' 'MANUAL' ("DHCP address " + (($dhcp | ForEach-Object { $_.IPAddress }) -join ', ') + ": confirm a DHCP reservation for it")
} else {
    Add-Result 'Fixed address' 'PASS' "static: $ipList"
}

Add-Result 'Remote access' 'MANUAL' 'confirm QIP Digital can reach this server remotely (RDP or another tool)'
Add-Result 'Windows Update' 'MANUAL' 'set active hours so updates never restart the server during a shift'

$results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
$failed = @($results | Where-Object { $_.Status -eq 'FAIL' })
if ($failed.Count -gt 0) {
    Write-Host "$($failed.Count) check(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host 'No check failed. Confirm the MANUAL lines by hand.' -ForegroundColor Green
exit 0
