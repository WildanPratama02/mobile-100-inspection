<#
.SYNOPSIS
  Upgrades M100 to a new release, or rolls back to the previous one (doc 03 section 7.6, T4.1).

.DESCRIPTION
  Upgrade: unpacks the release next to the old one (releases\<version>), takes a pg_dump first (backup
  --kind pre-upgrade), stops the API, runs db:migrate from the new release, switches the junction `current`,
  rewrites the service definitions, starts the API and Caddy and checks the API's health. If the new API does not
  become healthy, automatic fallback requires identical migration histories. Otherwise services stay stopped
  for forward recovery or coordinated restore (docs/phase5-recovery-runbook.md). Liveness is not readiness.

  Rollback: switches `current` back to the release that was current before the last upgrade.

  Do it at a shift change: requests in flight fail and the tablets resend them.

.EXAMPLE
  .\upgrade.ps1 -Release D:\setup\m100-2026.11.20-ef45ab6.zip
.EXAMPLE
  .\upgrade.ps1 -Rollback
#>
[CmdletBinding(DefaultParameterSetName = 'Upgrade')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Upgrade')] [string] $Release,
    [Parameter(Mandatory = $true, ParameterSetName = 'Rollback')] [switch] $Rollback,
    [string] $Root,
    # Release folders kept besides the current and the previous one.
    [int] $Keep = 5
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if (-not $Root) { $Root = Find-InstallRoot $PSScriptRoot }
$settings = Read-InstallSettings $Root
$current = Join-Path $Root 'current'
$previousFile = Join-Path $Root 'previous-release.txt'
$oldDir = Get-JunctionTarget $current
if (-not $oldDir) { throw "$current is not a junction: run install.ps1 first" }

function Switch-Release([string] $From, [string] $To) {
    Stop-M100Services
    Set-Junction $current $To
    Write-ServiceDefinitions $settings $To
    Start-M100Services $settings
    Write-TextFile $previousFile @($From)
}

if ($Rollback) {
    if (-not (Test-Path -LiteralPath $previousFile)) { throw 'No previous release recorded: nothing to roll back to' }
    $target = ([IO.File]::ReadAllText($previousFile)).Trim()
    if (-not (Test-Path -LiteralPath $target)) { throw "The previous release $target is gone" }
    Assert-CodeRollbackCompatible $oldDir $target
    Write-Step "Rollback: $oldDir -> $target"
    Switch-Release $oldDir $target
    Write-Host "Rolled back to $target." -ForegroundColor Green
    exit 0
}

Write-Step "Unpack $Release"
$newDir = Expand-Release $Release $Root
if ([IO.Path]::GetFullPath($newDir) -eq [IO.Path]::GetFullPath($oldDir)) { throw "$newDir is already the current release" }

Write-Step 'Backup before the upgrade (pg_dump)'
Invoke-Cli $settings $oldDir 'backup' @('--kind', 'pre-upgrade')

Write-Step 'Stop the API; migrate with the new release'
Stop-M100Services
try {
    Invoke-Cli $settings $newDir 'db-migrate'
} catch {
    Write-Warning "db:migrate failed: $($_.Exception.Message). Checking fallback compatibility."
    Assert-CodeRollbackCompatible $newDir $oldDir
    Start-M100Services $settings
    throw
}

Write-Step "Switch current: $oldDir -> $newDir"
try {
    Switch-Release $oldDir $newDir
} catch {
    Write-Warning "The new release did not start: $($_.Exception.Message). Checking fallback compatibility."
    Stop-M100Services
    Assert-CodeRollbackCompatible $newDir $oldDir
    Set-Junction $current $oldDir
    Write-ServiceDefinitions $settings $oldDir
    Start-M100Services $settings
    throw "Upgrade to $newDir failed and was rolled back; see $Root\logs\m100-api*.log"
}

Write-Step 'Remove old releases'
$protected = @([IO.Path]::GetFullPath($newDir), [IO.Path]::GetFullPath($oldDir))
$others = @(Get-ReleaseFolders $Root | Where-Object { $protected -notcontains $_.FullName })
foreach ($folder in ($others | Select-Object -Skip $Keep)) {
    Write-Host "Removing $($folder.FullName)"
    Remove-Item -LiteralPath $folder.FullName -Recurse -Force
}

try {
    Wait-Health "https://$($settings.PublicHost)/v1/health" 60
} catch {
    Write-Warning "https://$($settings.PublicHost)/v1/health: $($_.Exception.Message)"
}
Write-Host "Upgraded to $newDir. Verify readiness and a real submission before releasing tablets." -ForegroundColor Green
Write-Host 'Code rollback requires identical migration histories; otherwise use the recovery runbook.'
