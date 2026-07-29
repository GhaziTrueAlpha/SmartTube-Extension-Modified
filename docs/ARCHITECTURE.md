# SmartTube Bridge — Architecture

## Overview

SmartTube Bridge is a Windows desktop application that allows users to cast YouTube videos from Chrome directly to SmartTube running on an Android TV. The system uses ADB (Android Debug Bridge) to send intents and key events to the TV.

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Chrome Browser                        │
│  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │  Extension Popup  │  │  Content Script (floating   │  │
│  │  + Context Menu   │  │  button injected on YT)     │  │
│  └────────┬─────────┘  └──────────────┬──────────────┘  │
│           │                           │                  │
│           └──────────┬────────────────┘                  │
│                      │ HTTP POST /api/cast               │
│                      ▼                                   │
│              http://localhost:8765                       │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│             SmartTube Bridge Service                    │
│              (Windows Background Service)               │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │             ASP.NET Core Web API                  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │  Cast    │ │  Media   │ │  Device/Layout   │  │  │
│  │  │Controller│ │Controller│ │  Controllers     │  │  │
│  │  └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │  │
│  │       │            │                │            │  │
│  │  ┌────▼────────────▼────────────────▼─────────┐  │  │
│  │  │          MediaCommandService               │  │  │
│  │  └────────────────┬───────────────────────────┘  │  │
│  │                   │                              │  │
│  │  ┌────────────────▼───────────────────────────┐  │  │
│  │  │               AdbService                   │  │  │
│  │  │  (Process.Start -> adb.exe)                │  │  │
│  │  └────────────────┬───────────────────────────┘  │  │
│  └───────────────────┼──────────────────────────────┘  │
└──────────────────────┼──────────────────────────────────┘
                       │ adb shell am start / input keyevent
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Android TV / ADB Connection                │
│                                                        │
│    ┌──────────────────────────────────────────────┐     │
│    │           SmartTube (org.smarttube.stable)    │     │
│    │  - Opens URLs via ACTION.VIEW intent         │     │
│    │  - Responds to media key events              │     │
│    └──────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

## Projects

### SmartTubeBridge.Shared
Class library containing all shared models, enums, interfaces, and constants. Zero external dependencies.

### SmartTubeBridge.Service
Windows Background Service hosting an ASP.NET Core Web API on `http://localhost:8765`. Runs silently with no console window. Communicates with ADB via `Process.Start`. Implements exponential backoff reconnection, wake-before-action logic, and structured logging.

### SmartTubeBridge.Tray
System tray application with NotifyIcon. Shows connection status, provides context menu for quick actions (Dashboard, Reconnect, Settings, Exit). Polls the service API every 5 seconds for status updates.

### SmartTubeBridge.Dashboard
WPF desktop application with dark Material Design theme. Provides full device management, media controls, settings configuration, log viewer, and a setup wizard for first-time configuration.

### SmartTubeBridge.Extension
Chrome Manifest V3 extension. Injects a floating button on YouTube pages, adds right-click context menu items, and provides a popup with full media controls. Communicates with the service via HTTP to localhost:8765.

## Communication

All communication between the extension and the service uses HTTP REST on `127.0.0.1:8765`. No external network access. The service validates all requests to prevent command injection.

## Key Design Decisions

1. **HTTP over Native Messaging**: Using HTTP from the extension simplifies deployment (no registry changes for the extension) and allows multiple clients (tray, dashboard, extension) to share the same backend.

2. **Windows Service**: Running as a Windows Service ensures ADB stays connected even when no user is logged in, enables auto-start on boot, and provides automatic restart on failure.

3. **Wake Before Action**: Every media command and cast operation first sends KEYCODE_WAKEUP to ensure the TV is awake before sending the actual command. The wake delay is configurable (default 500ms).

4. **Exponential Backoff**: When the TV disconnects, the service retries with exponential backoff (1s, 2s, 4s, 8s, 16s) to avoid flooding.

5. **Security**: The API is bound to localhost only. All request bodies are validated to prevent shell injection. Only predefined commands are executed — no arbitrary shell execution.
