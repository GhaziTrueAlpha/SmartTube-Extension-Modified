using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Shared.Interfaces;

public interface IDeviceManager
{
    DeviceInfo? PreferredDevice { get; }
    IReadOnlyList<DeviceInfo> KnownDevices { get; }
    event EventHandler<DeviceInfo>? DeviceConnected;
    event EventHandler<DeviceInfo>? DeviceDisconnected;

    Task RefreshAsync(CancellationToken ct = default);
    Task<bool> ConnectAsync(string serial, CancellationToken ct = default);
    Task DisconnectAsync(string serial, CancellationToken ct = default);
    Task AutoConnectAsync(CancellationToken ct = default);
    void AddOrUpdate(DeviceInfo device);
    void Remove(string id);
    void SetPreferred(string id);
    DeviceInfo? GetById(string id);
    DeviceInfo? GetBySerial(string serial);
}
