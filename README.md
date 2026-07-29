# SmartTube Bridge (Modified)

Cast YouTube videos from Chrome to SmartTube on Android TV — no server, no cloud, no hassle.

## How It Works

1. **Chrome Extension** sends the current YouTube URL (or media command) to a local Windows service
2. **SmartTube Bridge Service** receives the request and executes ADB commands against your Android TV
3. **ADB** sends an intent to SmartTube (`org.smarttube.stable`) with the YouTube URL
4. **SmartTube** opens the video instantly

## Components

| Component | Technology | Description |
|-----------|-----------|-------------|
| Service | .NET 10 / ASP.NET Core | Windows background service with REST API on `localhost:8765` |
| Tray App | WPF .NET 10 | System tray icon with connection status and quick actions |
| Dashboard | WPF .NET 10 | Full management UI with dark mode, device mgmt, logs, wizard |
| Extension | Chrome MV3 | Popup, context menu, floating button on YouTube pages |

## Quick Start

### Prerequisites
- Windows 10/11
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) (to build)
- Android TV with [SmartTube](https://github.com/aprosLab/SmartTubeNext) installed
- ADB connectivity to your TV (USB or TCP/IP)
- Google Chrome

### One-Time Setup (Recommended)

```powershell
# Run PowerShell as Administrator, then:
.\scripts\setup.ps1
```

This single command builds everything, runs tests, installs the Windows Service with auto-start + network dependencies, creates Desktop and Startup shortcuts, and loads the Chrome extension.

Options: `-SkipBuild`, `-SkipService`, `-SkipExtension`, `-SkipAutostart`

### Manual Build & Install

```powershell
# Build everything
.\scripts\build.ps1 -Configuration Release -RunTests -Package

# Install the Windows service (run as Administrator)
.\scripts\install-service.ps1
```

### Chrome Extension Setup
1. Open `chrome://extensions` → Enable Developer Mode → Load Unpacked
2. Select `src/SmartTubeBridge.Extension`
3. The extension appears in your toolbar

### Connect Your TV
1. Click the extension icon
2. Open the Dashboard (or right-click tray icon → Dashboard)
3. Go to Setup Wizard tab
4. Locate `adb.exe` path (Browse button)
5. Click **Scan Devices** — should show your TV if ADB over TCP/IP is enabled
6. Enter your TV's IP address and click Connect
7. Open a YouTube video and click "Play on SmartTube"

## ADB Connection Methods

**USB**: Connect your TV to your PC via USB. Run `adb devices` to verify.

**TCP/IP**: From your TV's network settings, note the IP address. Enable ADB debugging over network in Developer Options. The service auto-connects on startup.

## Configuration

Settings are stored at `%ProgramData%\SmartTubeBridge\config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| adbPath | "adb" | Path to adb.exe |
| packageName | "org.smarttube.stable" | SmartTube package name |
| apiPort | 8765 | Local API port |
| wakeDelayMs | 500 | Delay after wake command (ms) |
| autoConnect | true | Auto-connect on service start |
| enableFloatingButton | true | Show floating button on YouTube |
| enableContextMenu | true | Add right-click menu items |

## API

Full API documentation: [docs/API.md](docs/API.md)

## Architecture

Detailed architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Project Handover

Complete project documentation: [PROJECT_HANDOVER.md](PROJECT_HANDOVER.md)

## License

MIT
