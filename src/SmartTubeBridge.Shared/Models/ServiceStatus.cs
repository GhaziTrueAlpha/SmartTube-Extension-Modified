using SmartTubeBridge.Shared.Enums;

namespace SmartTubeBridge.Shared.Models;

public class ServiceStatus
{
    public string Version { get; set; } = "1.0.0";
    public bool ServiceRunning { get; set; }
    public AdbState AdbState { get; set; } = AdbState.Unknown;
    public DeviceConnectionState DeviceState { get; set; } = DeviceConnectionState.Disconnected;
    public DeviceInfo? CurrentDevice { get; set; }
    public string? AdbPath { get; set; }
    public string PackageName { get; set; } = "org.smarttube.stable";
    public int WakeDelayMs { get; set; } = 500;
    public int ActiveConnections { get; set; }
    public DateTime Uptime { get; set; }
    public string? LastError { get; set; }
    public bool IsConnected => DeviceState == DeviceConnectionState.Connected;
}
