param(
    [string]$ServiceDir = "$PSScriptRoot\..\dist\service"
)

$ErrorActionPreference = "Stop"

$resolved = Resolve-Path $ServiceDir -ErrorAction Stop
$servicePath = Join-Path $resolved "SmartTubeBridge.Service.exe"
if (-not (Test-Path $servicePath)) {
    throw "Service binary not found: $servicePath`nRun .\scripts\build.ps1 -Package first."
}

$serviceName = "SmartTubeBridgeService"
$displayName = "SmartTube Bridge Service"
$dataDir = Join-Path $env:ProgramData "SmartTubeBridge"

Write-Host "=== Installing SmartTube Bridge Service ===" -ForegroundColor Cyan
Write-Host "Binary: $servicePath" -ForegroundColor White

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: Administrator privileges required to install a Windows Service." -ForegroundColor Red
    Write-Host "Please run this script as Administrator." -ForegroundColor Yellow
    exit 1
}

# Stop competing console instances so the Windows Service can bind the API port
Get-Process -Name "SmartTubeBridge.Service" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping interactive process PID $($_.Id)..." -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# Stop and remove existing service if present
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing service..." -ForegroundColor Yellow
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 2
    Write-Host "Existing service removed." -ForegroundColor Green
}

# Shared config/logs for LocalSystem + interactive apps
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dataDir "logs") -Force | Out-Null

$sharedConfig = Join-Path $dataDir "config.json"
$legacyCandidates = @(
    (Join-Path $env:APPDATA "SmartTubeBridge\config.json"),
    (Join-Path $env:ProgramData "SmartTubeBridge\config.json"),
    "C:\Windows\System32\config\systemprofile\AppData\Roaming\SmartTubeBridge\config.json"
)
$bestLegacy = $null
$bestScore = -1
foreach ($candidate in $legacyCandidates) {
    if (-not (Test-Path $candidate)) { continue }
    $text = Get-Content $candidate -Raw
    $score = $text.Length
    if ($text -match '"SavedDevices"\s*:\s*\[\s*\{') { $score += 100000 }
    if ($score -gt $bestScore) {
        $bestScore = $score
        $bestLegacy = $candidate
    }
}
if ($bestLegacy -and $bestLegacy -ne $sharedConfig) {
    Copy-Item $bestLegacy $sharedConfig -Force
    Write-Host "Migrated config from $bestLegacy" -ForegroundColor Green
}

# Install service (LocalSystem). Binary path must stay quoted for spaces.
Write-Host "Installing service..." -ForegroundColor Yellow
New-Service -Name $serviceName `
    -DisplayName $displayName `
    -Description "Background service for SmartTube Bridge. Casts YouTube videos to SmartTube on Android TV via ADB." `
    -BinaryPathName "`"$servicePath`"" `
    -StartupType Automatic `
    -ErrorAction Stop

# Delayed auto-start + recovery
sc.exe config $serviceName start= delayed-auto | Out-Null
sc.exe failure $serviceName reset=86400 actions=restart/5000/restart/10000/restart/30000 | Out-Null
sc.exe failureflag $serviceName 1 | Out-Null

# Ensure LocalSystem can read the published binary folder and ProgramData
$acl = Get-Acl -Path "$resolved"
$systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "NT AUTHORITY\SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
$acl.SetAccessRule($systemRule)
Set-Acl -Path "$resolved" -AclObject $acl

$dataAcl = Get-Acl -Path $dataDir
$usersRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "BUILTIN\Users", "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")
$dataAcl.SetAccessRule($systemRule)
$dataAcl.SetAccessRule($usersRule)
Set-Acl -Path $dataDir -AclObject $dataAcl

Start-Service -Name $serviceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $serviceName
if ($svc.Status -ne 'Running') {
    Write-Host "ERROR: Service installed but not running (status=$($svc.Status))." -ForegroundColor Red
    Write-Host "Check Event Viewer > Windows Logs > System for SmartTubeBridgeService." -ForegroundColor Yellow
    exit 1
}

try {
    $health = Invoke-RestMethod "http://127.0.0.1:8765/health" -TimeoutSec 5
    Write-Host "Health: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "WARNING: Service is running but health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "Service installed and started successfully!" -ForegroundColor Green
Write-Host "`nService: $displayName ($serviceName)" -ForegroundColor White
Write-Host "Binary: $servicePath" -ForegroundColor White
Write-Host "Data:   $dataDir" -ForegroundColor White
Write-Host "`nTo manage the service:" -ForegroundColor Cyan
Write-Host "  Start   : Start-Service -Name $serviceName" -ForegroundColor Gray
Write-Host "  Stop    : Stop-Service -Name $serviceName" -ForegroundColor Gray
Write-Host "  Restart : Restart-Service -Name $serviceName" -ForegroundColor Gray
Write-Host "  Uninstall: sc.exe delete $serviceName" -ForegroundColor Gray
