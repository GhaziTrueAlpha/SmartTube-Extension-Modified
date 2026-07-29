# SmartTube Bridge — Full Project Handover

## 1. What It Is

SmartTube Bridge is a **Windows desktop application + Chrome extension** that lets you cast YouTube videos from Chrome to [SmartTube](https://github.com/aprosLab/SmartTubeNext) on an Android TV — entirely **local, no cloud, no Node.js**. It replaces the Android phone "share to TV" flow with a browser button.

**Data flow:** Chrome Extension → HTTP POST `localhost:8765` → .NET 10 Windows Service → `adb.exe` → Android TV → SmartTube opens the video.

---

## 2. Solution Architecture (5 Projects)

```
SmartTubeBridge.sln
├── src/
│   ├── SmartTubeBridge.Shared/       (#1) Class library — no dependencies
│   ├── SmartTubeBridge.Service/      (#2) ASP.NET Core Windows Service
│   ├── SmartTubeBridge.Dashboard/    (#3) WPF management UI
│   ├── SmartTubeBridge.Tray/         (#4) System tray icon + WinForms
│   └── SmartTubeBridge.Extension/    (#5) Chrome MV3 extension
├── tests/
│   ├── SmartTubeBridge.Shared.Tests/  (12 tests)
│   └── SmartTubeBridge.Service.Tests/ (3 tests)
├── scripts/
│   ├── build.ps1                      (build + test + package)
│   └── install-service.ps1            (register Windows Service, Admin)
├── docs/
│   ├── API.md                         (REST endpoint reference)
│   └── ARCHITECTURE.md                (system architecture diagram)
├── dist/                              (published output)
│   ├── service/                       (self-contained Service exe)
│   ├── tray/                          (self-contained Tray exe)
│   └── dashboard/                     (self-contained Dashboard exe)
├── assets/
│   └── icon.ico                       (app icon)
└── SmartTubeBridge.sln
```

### Shared Library (`SmartTubeBridge.Shared`)
**Target:** `net10.0`, zero external dependencies.

| Folder | Files | Purpose |
|--------|-------|---------|
| `Constants/` | `ApiRoutes.cs`, `KeyCodes.cs` | REST route constants, Android key code integers |
| `Enums/` | `AdbState.cs`, `DeviceConnectionState.cs`, `LogLevel.cs`, `MediaAction.cs`, `WakeDelay.cs` | All shared enums |
| `Exceptions/` | `SmartTubeBridgeException.cs` | Base exception + `AdbNotFoundException`, `DeviceNotConnectedException`, `InvalidUrlException` |
| `Helpers/` | `AdbPathHelper.cs`, `AppPaths.cs`, `YouTubeUrlHelper.cs` | ADB discovery, unified data dir, YouTube URL parsing |
| `Interfaces/` | `IAdbService.cs`, `IConfigService.cs`, `IDeviceManager.cs`, `ILogService.cs`, `IMediaCommandService.cs` | All DI interfaces |
| `Models/` | `AppConfig.cs`, `DeviceInfo.cs`, `LogEntry.cs`, `MediaCommand.cs`, `ServiceStatus.cs` | Data transfer objects + `ApiResponse` envelope |

**Key classes:**

- **`AdbPathHelper`**: Searches for `adb.exe` on PATH and common SDK locations (including WinGet path). `DiscoverCandidates()` returns all found copies. `IsDefaultPath()` treats empty or `"adb"` as "not yet configured". **Bug history**: `IsValidPath("adb")` returned true trivially, preventing auto-detection — fixed by removing early-return in `FindAdbAsync()`.

- **`AppPaths`**: Unified data directory at `%ProgramData%\SmartTubeBridge`. Handles migration from legacy `%AppData%\SmartTubeBridge` configs (reads all user folders under `C:\Users\` and picks the one with the most saved devices).

- **`YouTubeUrlHelper`**: Extracts 11-char video IDs from all YouTube URL formats (`/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`). `Normalize()` preserves `list` (playlist) and `t` (timestamp) params.

### Service (`SmartTubeBridge.Service`)
**Target:** `net10.0`, **self-contained** `win-x64`.

**DI wiring** (in `Program.cs`):
```
ConfigService (Singleton) → IConfigService
LogService (Singleton)    → ILogService
AdbService (Singleton)    → IAdbService
DeviceManager (Singleton) → IDeviceManager
MediaCommandService (Singleton) → IMediaCommandService
SmartTubeWorker (HostedService) — background startup logic
```

**Startup flow (Program.cs):**
1. Global mutex (`Global\SmartTubeBridgeService.SingleInstance`) prevents multiple instances
2. Read `config.json` from `AppPaths.ConfigPath` for port number. CLI `--port` arg overrides config.
3. Check port availability via `TcpListener`
4. Build `WebApplication` with `UseWindowsService()` for SCM integration
5. Register all services, middleware, controllers, CORS (allow all origins — localhost only)
6. Start Kestrel on `http://127.0.0.1:{apiPort}`
7. `SmartTubeWorker.ExecuteAsync` runs after Kestrel binds (750ms delay), loads config, starts ADB, auto-connects devices
8. Catches all exceptions in worker — keeps API alive even if ADB fails

**Key bug fixes applied:**
- `LogService.WriteToConsole` guarded with `if (!Environment.UserInteractive) return;` + try-catch (silent when running as Windows Service with no console)
- Port conflict detection: checks port BEFORE starting Kestrel, shows clear error message
- Self-contained publish with all .NET assemblies bundled (162KB exe + runtime DLLs)
- `UseWindowsService()` moved to `builder.Host.UseWindowsService()` pattern for .NET 10 compatibility

#### Controllers (REST API on `http://localhost:8765/api/`)

| Controller | Routes | Key Methods |
|-----------|--------|-------------|
| `StatusController` | `GET /status`, `GET /ping` | Returns `ServiceStatus` with ADB state, device info, config |
| `CastController` | `POST /cast`, `POST /cast/search` | Forwards to `MediaCommandService.CastUrlAsync` |
| `DeviceController` | `GET /device`, `POST /device/scan`, `POST /device/connect`, `POST /device/disconnect`, `POST /{id}/prefer`, `DELETE /{id}` | Full device lifecycle. Connect saves to config with auto-connect=true |
| `MediaController` | `POST /media/{action}` (20+ endpoints) | Play, pause, next, prev, ff, rw, stop, volume up/down/mute, home, back, dpad, seek, position |
| `SettingsController` | `GET /settings`, `POST /settings`, `GET /settings/adb/candidates`, `POST /settings/adb/test` | Config management + ADB path probe |
| `LogsController` | `GET /logs`, `DELETE /logs/clear` | Structured log retrieval |

**All responses use the `ApiResponse` envelope:**
```json
{ "success": true, "message": "...", "data": {...}, "errorCode": null }
```

#### Middleware
| Middleware | Purpose |
|-----------|---------|
| `ExceptionHandlingMiddleware` | Catches all exceptions, returns structured JSON errors with appropriate HTTP status codes |
| `RequestValidationMiddleware` | Blocks non-localhost requests (security via IP check), validates all POST bodies (JSON parse + SSRF prevention for URLs + shell injection guard) |

#### SmartTubeWorker (BackgroundService)
- 750ms delay on start (lets Kestrel bind first)
- `_config.LoadAsync()` → `_adb.StartAsync()` → optional `_devices.AutoConnectAsync()`
- If ADB fails (e.g. adb.exe not found), logs error but **keeps the API running** so settings can be fixed
- On service stop: calls `_adb.StopAsync()` to run `adb kill-server`

#### AdbService (Core ADB interaction)
- Uses `Process.Start` with `UseShellExecute=false`, `CreateNoWindow=true`
- `FindAdbAsync()`: auto-detects `adb.exe` on PATH → checks `DefaultSdkPaths` (common SDK dirs + WinGet path). Saves detected path to config.
- `RunAsync()`: returns `(exitCode, output)` tuple. Merges stdout+stderr.
- `OpenUrlAsync()`: tries multiple intent patterns for SmartTube (SplashActivity + vnd.youtube:// + https://), falls back to `-p <package>`.
- `SeekToAsync()`: re-opens video with `&t={seconds}` timestamp in URL
- `SetVolumeAsync()`: tries multiple `cmd media_session` / `settings put` commands, finally falls back to keyevents
- `GetPlaybackPositionAsync()`: parses `dumpsys media_session` for SmartTube's PlaybackState
- `BuildPackageCandidates()`: tries configured package, `org.smarttube.stable`, `com.teamsmart.videomanager.tv`, `org.smarttube.beta`, `com.liskovsoft.smarttubetv.beta`
- **Thread safety**: `SemaphoreSlim` guard on Start/Stop, `Dispose` with `Interlocked`

#### DeviceManager
- Maintains in-memory `List<DeviceInfo>` with events `DeviceConnected` / `DeviceDisconnected`
- `PreferredDevice`: first connected preferred device, fallback to first connected
- `AutoConnectAsync()`: reconnects all TCP saved devices on service start (wireless ADB must reconnect after ADB server restart)
- `SyncSavedDevicesAsync()`: merges live ADB state into config (preserves offline TCP entries)

#### ConfigService
- Reads/writes `%ProgramData%\SmartTubeBridge\config.json`
- JSON case-insensitive deserialization (`PropertyNameCaseInsensitive = true`)
- Thread-safe writes via `lock`
- Fires `ConfigChanged` event on updates

#### LogService
- In-memory ring buffer (500 entries) + per-day file at `%ProgramData%\SmartTubeBridge\logs\smarttube-{yyyy-MM-dd}.log`
- Each log entry is a JSON line (one per file line)
- `GetLogsAsync()`: reads last 10 log files, filters by time/level
- `WriteToConsole()`: guarded by `!Environment.UserInteractive` — silent when running as Windows Service

### Dashboard (`SmartTubeBridge.Dashboard`)
**Target:** `net10.0-windows`, **self-contained** `win-x64`, WPF.

| File | Purpose |
|------|---------|
| `MainWindow.xaml` | Full UI: status cards, device list, media controls (play/pause/next/prev/ff/rw/vol/home/back), settings, logs, setup wizard |
| `MainWindow.xaml.cs` | 3-second poll loop, event handlers for all buttons, `ApiClient` for REST calls |
| `App.xaml` | Merges `DarkTheme.xaml` |
| `App.xaml.cs` | `DispatcherUnhandledException`, `AppDomain.UnhandledException`, `UnobservedTaskException` handlers — shows MessageBox with error details |
| `Styles/DarkTheme.xaml` | Dark color scheme using `SolidColorBrush` resources |
| `Services/ApiClient.cs` | HTTP client wrapping all REST endpoints |

**XAML bug**: The error `Provide value on 'System.Windows.Baml2006.TypeConverterMarkupExtension'` occurs when resources are not found or type conversion fails during XAML load. This was caused by using `Color` resources (which XAML can't directly assign to `Background`/`Foreground` brush properties) instead of `SolidColorBrush`. **Fix**: All 10 color resources changed from `<Color x:Key="..." >#...</Color>` to `<SolidColorBrush x:Key="..." Color="#..." />`.

### Tray App (`SmartTubeBridge.Tray`)
**Target:** `net10.0-windows`, **self-contained** `win-x64`, WPF + WindowsForms.

Minimal app: `NotifyIcon` + `ContextMenuStrip` polling the service API. No XAML Window. `TrayApplication.cs` handles all logic — context menu items: Dashboard, Reconnect TV, Settings, Restart Service, Exit. Programmatic icon generation (blue square + "S" letter). Polls `/api/status` every 5 seconds.

### Chrome Extension (`SmartTubeBridge.Extension`)
**Manifest V3**, no external dependencies.

| File | Lines | Purpose |
|------|-------|---------|
| `manifest.json` | 39 | Permissions: `activeTab`, `storage`, `contextMenus`. Host: `localhost:8765`. Content scripts on `youtube.com` and `youtu.be` |
| `background.js` | 191 | Service worker. Context menus (Play, Stop, Search). Message router for 15+ action types. `apiGet`/`apiPost` wrappers |
| `content.js` | 1347 | **Most complex file.** Injected SmartTube player bar below YouTube video. **Three playback modes:** TV-only (laptop paused), **Synced** (both play together with lag compensation + Up Next), Independent |
| `popup.html` | 178 | Popup UI: status dot, device name, cast button, media controls, expandable panel with settings/devices/logs/wizard |
| `popup.js` | 445 | Popup logic: play-on-click, mode selector, seek slider, delay controls, device management, settings, logs |
| `style.css` | 309 | Dark theme popup styles |
| `floating-button.css` | 9 | Legacy styles (minimal) |

#### Synced Playback (most complex feature in `content.js`)
Uses `chrome.runtime.sendMessage` relay through `background.js` → HTTP to service. Key mechanics:
- `alignedSeek()`: seeks laptop, pushes seek to TV, waits for TV settle (auto-calibrated via `waitForTvReady()`), then starts both at 1.0x
- `startMatchedPlayback()`: starts laptop/TV with configurable `delayLaptopMs` / `delayTvMs` compensation (default: laptop +1.35s behind TV)
- `syncPollTimer`: every 1s reads TV position via `dumpsys media_session`, bridges laptop, mirrors pause/play
- `handleLaptopEnded()`: pauses TV, triggers YouTube "Up Next", re-casts new video
- No `playbackRate` manipulation — both always 1.0x for audio pitch correctness
- **Known SmartTube issue**: near-end TV pauses to prevent SmartTube autoplay, then laptop navigates to next video via `goToYouTubeNext()`

#### Extension Message Protocol
```
Popup/Content Script  →  chrome.runtime.sendMessage()  →  background.js  →  fetch() to localhost:8765  →  Service
```

### Tests (`tests/`)

**Shared.Tests** (12 tests):
- `YouTubeUrlHelperTests`: URL normalization, video ID extraction (various formats)
- `KeyCodesTests`: enum descriptions
- `AppConfigTests`: defaults
- `AdbPathHelperTests`: path detection
- `ApiResponseTests`: envelope serialization

**Service.Tests** (3 tests):
- `AdbServiceTests.StartAsync`: mock FindAdbAsync + RunAsync
- `ConfigServiceTests.LoadAsync`: file-based config loading
- Using xUnit + NSubstitute for mocking

---

## 3. Build & Deploy

### Prerequisites
- .NET 10 SDK
- Windows 10/11
- Android TV with SmartTube + ADB TCP/IP enabled

### Build
```powershell
.\scripts\build.ps1 -Configuration Release -RunTests -Package
```
What it does:
1. `dotnet restore` solution
2. `dotnet build` solution
3. Package Chrome extension into `dist/smarttube-bridge-extension.zip`
4. `dotnet test` both test projects (if `-RunTests`)
5. `dotnet publish` all three apps as self-contained `win-x64` (if `-Package`)

### Install Service (Admin)
```powershell
.\scripts\install-service.ps1
```
- Stops any running console instances of the Service
- Removes existing service if present
- Migrates legacy config from `%AppData%/SmartTubeBridge` to `%ProgramData%/SmartTubeBridge`
- Registers as `SmartTubeBridgeService` (Auto-Delayed Start)
- Sets recovery options (3 restarts)
- ACLs: SYSTEM FullControl on binary folder, Users Modify on data directory
- Starts service, verifies health endpoint

### Manual Run (No Install)
```powershell
.\dist\service\SmartTubeBridge.Service.exe --port 8765
http://localhost:8765  # open in browser
```

### Chrome Extension
```
chrome://extensions → Developer Mode → Load Unpacked → src/SmartTubeBridge.Extension
```

---

## 4. Known Issues & Fixes Applied

| Issue | Fix |
|-------|-----|
| Service exe closed immediately with blank terminal | Port conflict detection added. Old process must be killed or reconfigured to different port |
| ADB not found when running as service | `AdbPathHelper.DefaultSdkPaths` now includes WinGet path. `FindAdbAsync()` bypass fixed — no longer short-circuits on default `"adb"` path |
| Dashboard XAML parse crash `TypeConverterMarkupExtension` | Changed `Color` resources to `SolidColorBrush` in DarkTheme.xaml |
| Dashboard crash on ADB path with spaces | Put quotes around commands or fix path parsing |
| Mutex collision between session 0 (service) and session 1 (console) | Changed mutex from `Local\` to `Global\` prefix for cross-session singleton |
| Old `dotnet exec` instances holding port 8765 | Must be killed via Task Manager or reboot |

## 5. Current Running State

- **Service**: Running on `http://127.0.0.1:8765`, ADB state = Running, 1 device detected
- **TV**: Connected at `192.168.1.136:5555` (Android TV)
- **Config**: ADB path set to WinGet install location
- **Dashboard**: Published to `dist/dashboard/`. XAML resources fixed.
- **Extension**: Ready to load at `src/SmartTubeBridge.Extension`
- **Build**: Self-contained `win-x64`, all 15 tests pass

## 6. Tech Stack Summary

| Component | Technology | Version |
|-----------|-----------|---------|
| Service API | ASP.NET Core (Kestrel) | .NET 10 |
| Desktop UI | WPF + WindowsForms | .NET 10 |
| Extension | Chrome MV3 | API localhost:8765 |
| ADB Protocol | Process.Start → adb.exe | Platform Tools 37+ |
| Serialization | System.Text.Json | .NET built-in |
| Testing | xUnit + NSubstitute | Latest |
| Publish | Self-contained single-folder | win-x64 |

## 7. Key Files Reference

| File | What to Edit |
|------|-------------|
| `src/SmartTubeBridge.Service/Program.cs` | Port config, DI registration, middleware pipeline |
| `src/SmartTubeBridge.Service/Services/AdbService.cs` | ADB start/stop/commands, intent broadcasting, volume, seek |
| `src/SmartTubeBridge.Service/Services/MediaCommandService.cs` | Orchestrates cast + media actions |
| `src/SmartTubeBridge.Service/Services/DeviceManager.cs` | Device tracking, auto-connect, saved device sync |
| `src/SmartTubeBridge.Service/Services/ConfigService.cs` | Config file I/O, JSON serialization, legacy migration |
| `src/SmartTubeBridge.Service/Services/LogService.cs` | Structured logging, file + console + in-memory |
| `src/SmartTubeBridge.Service/SmartTubeWorker.cs` | Background startup: load config, start ADB, auto-connect |
| `src/SmartTubeBridge.Shared/Helpers/AdbPathHelper.cs` | ADB path detection, SDK paths, PATH scan |
| `src/SmartTubeBridge.Shared/Helpers/AppPaths.cs` | Data directory, config path, legacy migration logic |
| `src/SmartTubeBridge.Shared/Helpers/YouTubeUrlHelper.cs` | Video ID extraction, URL normalization |
| `src/SmartTubeBridge.Dashboard/MainWindow.xaml` | WPF UI layout, styles, resource bindings |
| `src/SmartTubeBridge.Dashboard/MainWindow.xaml.cs` | Dashboard logic, poll loop, event handlers |
| `src/SmartTubeBridge.Extension/content.js` | Synced playback, player bar UI, seek alignment |
| `src/SmartTubeBridge.Extension/background.js` | Message router, context menus, HTTP relay |
| `src/SmartTubeBridge.Extension/popup.js` | Popup UI logic, device management, settings |
| `scripts/build.ps1` | Full build pipeline |
| `scripts/install-service.ps1` | Windows Service installation |
