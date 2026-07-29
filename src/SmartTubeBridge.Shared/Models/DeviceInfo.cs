using SmartTubeBridge.Shared.Enums;

namespace SmartTubeBridge.Shared.Models;

public class DeviceInfo
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string FriendlyName { get; set; } = string.Empty;
    public string Serial { get; set; } = string.Empty;
    public string IpAddress { get; set; } = string.Empty;
    public int Port { get; set; } = 5555;
    public DeviceConnectionState State { get; set; } = DeviceConnectionState.Disconnected;
    public DateTime LastConnected { get; set; }
    public bool AutoConnect { get; set; }
    public bool IsPreferred { get; set; }
    public string Transport { get; set; } = "usb";
    public string? AdbError { get; set; }
}
