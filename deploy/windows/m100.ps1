# M100 commands on the server (doc 03 section 7.4). Runs a command of the current release in the install folder,
# where .env is, the way the services run:
#
#   m100.ps1 admin:create --username admin
#   m100.ps1 import-master --dir D:\exports
#   m100.ps1 device:add --label "Tablet F3-01"      (also --batch tablets.csv --out sheet.html)
#   m100.ps1 device:revoke --label "Tablet F3-01"
#   m100.ps1 device:list
#   m100.ps1 sweep-photos --dry-run
#   m100.ps1 db:migrate
#   m100.ps1 backup                                  (a backup now)
#   m100.ps1 nightly                                 (the scheduled task: backup, log cleanup, disk check)
#
# Relative paths in the arguments are taken from the folder you run it in. No param block on purpose: the
# commands' own --options are passed through untouched in $args.

. (Join-Path $PSScriptRoot 'common.ps1')

$commands = @{
    'admin:create'  = 'admin-create'
    'import-master' = 'import-master'
    'device:add'    = 'device-add'
    'device:revoke' = 'device-revoke'
    'device:list'   = 'device-list'
    'sweep-photos'  = 'sweep-photos'
    'db:migrate'    = 'db-migrate'
    'backup'        = 'backup'
}

if ($args.Count -eq 0 -or ($args[0] -ne 'nightly' -and -not $commands.ContainsKey($args[0]))) {
    Write-Host ('Usage: m100.ps1 <' + (($commands.Keys | Sort-Object) + 'nightly' -join '|') + '> [options]')
    exit 2
}
$command = [string] $args[0]
$rest = @($args | Select-Object -Skip 1 | ForEach-Object { [string] $_ })

$root = Find-InstallRoot $PSScriptRoot
$settings = Read-InstallSettings $root
$current = Join-Path $root 'current'

if ($command -ne 'nightly') {
    # import-master and device:add resolve relative paths from INIT_CWD (doc 03 section 7.4).
    $env:INIT_CWD = (Get-Location).ProviderPath
    try {
        Invoke-Cli $settings $current $commands[$command] $rest
        exit 0
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}

# nightly: backup, then logs older than 30 days, then free disk. A failure is an Error event (source M100) for
# the monitoring of QIP Digital (doc 03 section 5.8) and a non-zero result of the task.
$logs = Join-Path $root 'logs'
$log = Join-Path $logs ('nightly-' + (Get-Date -Format 'yyyyMM') + '.log')
$failed = $false
try {
    Push-Location -LiteralPath $root
    # 2>&1 turns the CLI's stderr into error records; with 'Stop' the first one would end the script.
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $settings.Node (Join-Path $current 'api\dist\cli\backup.js') 2>&1 | ForEach-Object { [string] $_ }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = 'Stop'
        Pop-Location
    }
    Add-Content -LiteralPath $log -Value $output -Encoding UTF8
    if ($code -ne 0) {
        $failed = $true
        Write-M100Event ("M100 nightly backup FAILED:`n" + ($output -join "`n")) 1001 'Error'
    } else {
        Write-M100Event ("M100 nightly backup finished:`n" + ($output -join "`n")) 1000 'Information'
    }
} catch {
    $failed = $true
    Add-Content -LiteralPath $log -Value "nightly failed: $($_.Exception.Message)" -Encoding UTF8
    Write-M100Event "M100 nightly backup FAILED: $($_.Exception.Message)" 1001 'Error'
}

$cutoff = (Get-Date).AddDays(-30)
Get-ChildItem -LiteralPath $logs -File | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force

# Alert below 15 % free (doc 03 section 5.8, risk R4), on the data disk and the backup disk.
$dirs = @($root, $settings.BackupDir) | Where-Object { $_ }
foreach ($dir in $dirs) {
    try {
        $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($dir)))
        if ($drive.IsReady -and $drive.TotalSize -gt 0) {
            $freePercent = [math]::Round(100 * $drive.AvailableFreeSpace / $drive.TotalSize, 1)
            if ($freePercent -lt 15) {
                Write-M100Event "M100: only $freePercent % free on $($drive.Name) ($dir)" 1002 'Warning'
            }
        }
    } catch {
        # A share has no DriveInfo; its space is watched where it lives.
    }
}

if ($failed) { exit 1 }
exit 0
