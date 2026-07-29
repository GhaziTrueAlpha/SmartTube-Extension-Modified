# SmartTube Bridge — One-Time Full Setup Script
# Builds everything, installs service, configures auto-start, loads Chrome extension.
# Run as Administrator (PowerShell 5.1+ / PowerShell 7+)

param(
    [switch]$SkipBuild,
    [switch]$SkipService,
    [switch]$SkipExtension,
    [switch]$SkipAutostart,
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host @"

====================================================
  SmartTube Bridge — One-Time Full Setup
====================================================

"@ -ForegroundColor Cyan

# ── Admin check ──
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell → Run as Administrator, then re-run this script." -ForegroundColor Yellow
    pause
    exit 1
}

# ── 1. Check prerequisites ──
Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Cyan

$dotnetVersion = $null
try { $dotnetVersion = & dotnet --version 2>$null } catch { }
if (-not $dotnetVersion -or -not $dotnetVersion.StartsWith("10.")) {
    Write-Host "ERROR: .NET 10 SDK is required." -ForegroundColor Red
    Write-Host "Download: https://dotnet.microsoft.com/download/dotnet/10.0" -ForegroundColor Yellow
    pause
    exit 1
}
Write-Host "  .NET SDK: $dotnetVersion" -ForegroundColor Green

if (-not (Get-Command "adb" -ErrorAction SilentlyContinue)) {
    Write-Host "  WARNING: adb.exe not found on PATH." -ForegroundColor Yellow
    Write-Host "  The service will auto-detect it from SDK locations or WinGet." -ForegroundColor Yellow
    Write-Host "  Install Android Platform Tools: winget install Google.PlatformTools" -ForegroundColor Yellow
}

$chromePath = $null
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)
foreach ($p in $chromePaths) {
    if (Test-Path $p) { $chromePath = $p; break }
}
if ($chromePath) {
    Write-Host "  Chrome: $chromePath" -ForegroundColor Green
} else {
    Write-Host "  WARNING: Google Chrome not found at standard locations." -ForegroundColor Yellow
}

# ── 2. Build ──
if (-not $SkipBuild) {
    Write-Host "`n[2/5] Building project..." -ForegroundColor Cyan

    $buildScript = Join-Path $root "scripts\build.ps1"
    if (-not (Test-Path $buildScript)) {
        Write-Host "ERROR: build.ps1 not found at $buildScript" -ForegroundColor Red
        exit 1
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript -Configuration Release -RunTests -Package
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Build failed." -ForegroundColor Red
        pause
        exit 1
    }
    Write-Host "  Build complete." -ForegroundColor Green
} else {
    Write-Host "`n[2/5] Build SKIPPED (--SkipBuild)" -ForegroundColor Yellow
}

# ── 3. Install Windows Service ──
if (-not $SkipService) {
    Write-Host "`n[3/5] Installing Windows Service..." -ForegroundColor Cyan

    $installScript = Join-Path $root "scripts\install-service.ps1"
    if (-not (Test-Path $installScript)) {
        Write-Host "ERROR: install-service.ps1 not found at $installScript" -ForegroundColor Red
        exit 1
    }

    $serviceDir = Join-Path $root "dist\service"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installScript -ServiceDir $serviceDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: Service installation may have had issues. Check output above." -ForegroundColor Yellow
    } else {
        Write-Host "  Service installed and running." -ForegroundColor Green
    }
} else {
    Write-Host "`n[3/5] Service install SKIPPED (--SkipService)" -ForegroundColor Yellow
}

# ── 4. Configure Auto-Start (Tray + Service) ──
if (-not $SkipAutostart) {
    Write-Host "`n[4/5] Configuring auto-start..." -ForegroundColor Cyan

    # The service is already set to delayed-auto by install-service.ps1.
    # Auto-start the Tray app so the user always gets the system-tray icon after login.

    $trayPath = Join-Path $root "dist\tray\SmartTubeBridge.Tray.exe"
    if (Test-Path $trayPath) {
        $startupDir = [Environment]::GetFolderPath("Startup")
        $shortcutPath = Join-Path $startupDir "SmartTube Bridge Tray.lnk"

        $WScriptShell = New-Object -ComObject WScript.Shell
        $shortcut = $WScriptShell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $trayPath
        $shortcut.WorkingDirectory = Split-Path $trayPath -Parent
        $shortcut.Description = "SmartTube Bridge System Tray"
        $shortcut.Save()

        Write-Host "  Tray app shortcut created in Startup folder." -ForegroundColor Green
        Write-Host "  Service is set to Delayed-Auto Start." -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Tray app not found at $trayPath" -ForegroundColor Yellow
        Write-Host "  Run build.ps1 -Package first." -ForegroundColor Yellow
    }

    # Also pin Dashboard shortcut for easy access
    $dashboardPath = Join-Path $root "dist\dashboard\SmartTubeBridge.Dashboard.exe"
    if (Test-Path $dashboardPath) {
        $desktopDir = [Environment]::GetFolderPath("Desktop")
        $deskShortcut = Join-Path $desktopDir "SmartTube Bridge Dashboard.lnk"

        $WScriptShell = New-Object -ComObject WScript.Shell
        $shortcut = $WScriptShell.CreateShortcut($deskShortcut)
        $shortcut.TargetPath = $dashboardPath
        $shortcut.WorkingDirectory = Split-Path $dashboardPath -Parent
        $shortcut.Description = "SmartTube Bridge Dashboard"
        $shortcut.Save()

        Write-Host "  Dashboard shortcut created on Desktop." -ForegroundColor Green
    }
} else {
    Write-Host "`n[4/5] Auto-start SKIPPED (--SkipAutostart)" -ForegroundColor Yellow
}

# ── 5. Chrome Extension ──
Write-Host "`n[5/5] Chrome Extension Setup..." -ForegroundColor Cyan

$extDir = Join-Path $root "src\SmartTubeBridge.Extension"
$extAbsPath = (Resolve-Path $extDir).Path

if (-not $SkipExtension) {
    if ($chromePath) {
        Write-Host "  Launching Chrome with SmartTube Bridge extension loaded..." -ForegroundColor Green
        Write-Host "  Extension path: $extAbsPath" -ForegroundColor Gray

        # Kill Chrome first so we can launch with --load-extension
        $chromeRunning = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
        if ($chromeRunning) {
            Write-Host "  NOTE: Chrome is currently running." -ForegroundColor Yellow
            Write-Host "  Close all Chrome windows first, then this script will re-launch it with the extension." -ForegroundColor Yellow
            Write-Host "  Or skip this step and load manually via chrome://extensions → Load Unpacked." -ForegroundColor Yellow
        } else {
            # Launch Chrome with extension auto-loaded
            Start-Process -FilePath $chromePath -ArgumentList "--load-extension=`"$extAbsPath`"", "https://www.youtube.com" -WindowStyle Normal
            Write-Host "  Chrome launched with extension loaded." -ForegroundColor Green
        }
    }

    Write-Host ""
    Write-Host "  ── Manual Extension Setup (if auto-load didn't work) ──" -ForegroundColor Yellow
    Write-Host "  1. Open Chrome and go to: chrome://extensions" -ForegroundColor White
    Write-Host "  2. Enable 'Developer mode' (toggle, top-right)" -ForegroundColor White
    Write-Host "  3. Click 'Load unpacked'" -ForegroundColor White
    Write-Host "  4. Select: $extAbsPath" -ForegroundColor White
    Write-Host "  5. Pin the extension for easy access" -ForegroundColor White
} else {
    Write-Host "  Skipped (--SkipExtension)" -ForegroundColor Yellow
    Write-Host "  Load manually: chrome://extensions → Load Unpacked → $extAbsPath" -ForegroundColor White
}

# ── Summary ──
Write-Host @"

====================================================
  SmartTube Bridge Setup Complete!
====================================================

  Service:      Running on http://localhost:$Port
  Tray:         Will auto-start on next login
  Dashboard:    Desktop shortcut created
  Extension:    See instructions above

  Next Steps:
  - Open the Dashboard and use the Setup Wizard to connect your TV
  - Enable ADB over TCP/IP on your Android TV
  - Click 'Scan' to find your TV on the network
  - Cast any YouTube video with the Chrome extension

====================================================

"@ -ForegroundColor Cyan

# ── Optional: Launch Dashboard immediately ──
$dashboardPath = Join-Path $root "dist\dashboard\SmartTubeBridge.Dashboard.exe"
if (Test-Path $dashboardPath) {
    Write-Host "Launching Dashboard now..." -ForegroundColor Green
    Start-Process -FilePath $dashboardPath
}

Write-Host "Setup finished. Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
