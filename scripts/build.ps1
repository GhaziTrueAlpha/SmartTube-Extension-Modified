param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [switch]$RunTests,
    [switch]$Package
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== SmartTube Bridge Build ===" -ForegroundColor Cyan
Write-Host "Configuration: $Configuration" -ForegroundColor White

# Restore
Write-Host "`nRestoring packages..." -ForegroundColor Yellow
dotnet restore $root\SmartTubeBridge.sln
if ($LASTEXITCODE -ne 0) { throw "Restore failed" }

# Build
Write-Host "`nBuilding solution..." -ForegroundColor Yellow
dotnet build $root\SmartTubeBridge.sln -c $Configuration --no-restore
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

# Build extension
Write-Host "`nPackaging Chrome extension..." -ForegroundColor Yellow
$extDir = "$root\src\SmartTubeBridge.Extension"
if (Get-Command "chrome" -ErrorAction SilentlyContinue) {
    chrome --pack-extension="$extDir" --pack-extension-key="$extDir\key.pem" 2>$null
}
if (-not (Test-Path "$extDir\..\..\dist")) { New-Item -ItemType Directory -Path "$root\dist" -Force | Out-Null }
Compress-Archive -Path "$extDir\*" -DestinationPath "$root\dist\smarttube-bridge-extension.zip" -Force
Write-Host "Extension packaged: dist\smarttube-bridge-extension.zip" -ForegroundColor Green

# Tests
if ($RunTests) {
    Write-Host "`nRunning tests..." -ForegroundColor Yellow
    dotnet test $root\tests\SmartTubeBridge.Shared.Tests -c $Configuration --no-build
    dotnet test $root\tests\SmartTubeBridge.Service.Tests -c $Configuration --no-build
    if ($LASTEXITCODE -ne 0) { throw "Tests failed" }
    Write-Host "All tests passed!" -ForegroundColor Green
}

# Publish
if ($Package) {
    Write-Host "`nPublishing service..." -ForegroundColor Yellow
    dotnet publish $root\src\SmartTubeBridge.Service -c $Configuration -o "$root\dist\service" --self-contained true -r win-x64
    dotnet publish $root\src\SmartTubeBridge.Tray -c $Configuration -o "$root\dist\tray" --self-contained true -r win-x64
    dotnet publish $root\src\SmartTubeBridge.Dashboard -c $Configuration -o "$root\dist\dashboard" --self-contained true -r win-x64
    Write-Host "Published to dist/" -ForegroundColor Green
}

Write-Host "`n=== Build Complete ===" -ForegroundColor Cyan
