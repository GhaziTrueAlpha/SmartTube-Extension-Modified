using SmartTubeBridge.Shared.Enums;

namespace SmartTubeBridge.Shared.Models;

public class AppConfig
{
    public string AdbPath { get; set; } = "adb";
    public string PackageName { get; set; } = "org.smarttube.stable";
    public int ApiPort { get; set; } = 8765;
    public int WakeDelayMs { get; set; } = 500;
    public string? PreferredDeviceId { get; set; }
    public bool AutoConnect { get; set; } = true;
    public bool LaunchAtStartup { get; set; } = true;
    public bool EnableFloatingButton { get; set; } = true;
    public bool EnableContextMenu { get; set; } = true;
    public bool CheckForUpdates { get; set; } = true;
    public LogLevel LoggingLevel { get; set; } = LogLevel.Info;
    public string Theme { get; set; } = "dark";
    public int RetryMaxAttempts { get; set; } = 5;
    public int RetryBaseDelayMs { get; set; } = 1000;
    public List<DeviceInfo> SavedDevices { get; set; } = new();
}
