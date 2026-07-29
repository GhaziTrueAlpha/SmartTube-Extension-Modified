using System.Collections.ObjectModel;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Services;

public class DeviceManager : IDeviceManager
{
    private readonly IAdbService _adb;
    private readonly IConfigService _config;
    private readonly ILogService _log;
    private readonly List<DeviceInfo> _devices = new();

    public DeviceInfo? PreferredDevice =>
        _devices.FirstOrDefault(d => d.IsPreferred && d.State == DeviceConnectionState.Connected)
        ?? _devices.FirstOrDefault(d => d.State == DeviceConnectionState.Connected);

    public IReadOnlyList<DeviceInfo> KnownDevices => _devices.AsReadOnly();
    public event EventHandler<DeviceInfo>? DeviceConnected;
    public event EventHandler<DeviceInfo>? DeviceDisconnected;

    public DeviceManager(IAdbService adb, IConfigService config, ILogService log)
    {
        _adb = adb;
        _config = config;
        _log = log;
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        var scanned = await _adb.ScanDevicesAsync(ct);

        foreach (var device in scanned)
        {
            var existing = _devices.FirstOrDefault(d => d.Serial == device.Serial);
            if (existing != null)
            {
                existing.State = device.State;
                existing.LastConnected = DateTime.UtcNow;
            }
            else
            {
                _devices.Add(device);
                if (device.State == DeviceConnectionState.Connected)
                    DeviceConnected?.Invoke(this, device);
            }
        }

        var serials = scanned.Select(d => d.Serial).ToHashSet();
        foreach (var d in _devices.Where(d => !serials.Contains(d.Serial) && d.State == DeviceConnectionState.Connected).ToList())
        {
            d.State = DeviceConnectionState.Disconnected;
            DeviceDisconnected?.Invoke(this, d);
        }

        await SyncSavedDevicesAsync();
    }

    public async Task<bool> ConnectAsync(string serial, CancellationToken ct = default)
    {
        var device = GetBySerial(serial);
        if (device == null)
        {
            _log.Warning("Devices", $"Unknown device: {serial}");
            return false;
        }

        if (device.Transport == "tcpip")
        {
            var state = await _adb.ConnectDeviceAsync(device.IpAddress, device.Port, ct);
            device.State = state;
        }

        if (device.State == DeviceConnectionState.Connected)
        {
            device.LastConnected = DateTime.UtcNow;
            DeviceConnected?.Invoke(this, device);
            await SyncSavedDevicesAsync();
            _log.Info("Devices", $"Connected: {device.FriendlyName}");
            return true;
        }

        return false;
    }

    public async Task DisconnectAsync(string serial, CancellationToken ct = default)
    {
        var device = GetBySerial(serial);
        if (device != null)
        {
            await _adb.DisconnectDeviceAsync(serial, ct);
            device.State = DeviceConnectionState.Disconnected;
            DeviceDisconnected?.Invoke(this, device);
        }
    }

    public async Task AutoConnectAsync(CancellationToken ct = default)
    {
        _log.Info("Devices", "Auto-connecting to known devices...");

        await RefreshAsync(ct);

        var saved = _config.Config.SavedDevices ?? [];
        var preferredId = _config.Config.PreferredDeviceId;

        // Always try preferred / flagged TCP targets even if adb devices is empty
        // (wireless ADB must be re-connected after the adb server restarts).
        var targets = saved
            .Where(s =>
                s.Transport == "tcpip" &&
                !string.IsNullOrWhiteSpace(s.IpAddress) &&
                (s.AutoConnect || s.IsPreferred ||
                 (!string.IsNullOrEmpty(preferredId) && s.Id == preferredId)))
            .GroupBy(s => $"{s.IpAddress}:{s.Port}")
            .Select(g => g.First())
            .ToList();

        if (targets.Count == 0 && !string.IsNullOrEmpty(preferredId))
        {
            var preferred = GetById(preferredId);
            if (preferred?.Transport == "tcpip" && !string.IsNullOrWhiteSpace(preferred.IpAddress))
                targets.Add(preferred);
        }

        foreach (var s in targets)
        {
            var serial = string.IsNullOrEmpty(s.Serial) ? $"{s.IpAddress}:{s.Port}" : s.Serial;
            if (GetBySerial(serial)?.State == DeviceConnectionState.Connected)
                continue;

            try
            {
                await _adb.ConnectDeviceAsync(s.IpAddress, s.Port > 0 ? s.Port : 5555, ct);
            }
            catch (Exception ex)
            {
                _log.Warning("Devices", $"Auto-connect failed for {s.IpAddress}:{s.Port}: {ex.Message}");
            }
        }

        await RefreshAsync(ct);
    }

    public void AddOrUpdate(DeviceInfo device)
    {
        var existing = GetBySerial(device.Serial);
        if (existing != null)
        {
            var idx = _devices.IndexOf(existing);
            _devices[idx] = device;
        }
        else
        {
            _devices.Add(device);
        }
    }

    public void Remove(string id)
    {
        var dev = GetById(id);
        if (dev != null) _devices.Remove(dev);
    }

    public void SetPreferred(string id)
    {
        foreach (var d in _devices) d.IsPreferred = false;
        var dev = GetById(id);
        if (dev != null) dev.IsPreferred = true;
    }

    public DeviceInfo? GetById(string id) =>
        _devices.FirstOrDefault(d => d.Id == id);

    public DeviceInfo? GetBySerial(string serial) =>
        _devices.FirstOrDefault(d => d.Serial == serial);

    private async Task SyncSavedDevicesAsync()
    {
        await _config.UpdateAsync(c =>
        {
            // Merge live ADB state into saved devices — never wipe offline TCP entries
            // just because `adb devices` is empty after an ADB server restart.
            foreach (var d in _devices)
            {
                var existing = c.SavedDevices.FirstOrDefault(s =>
                    (!string.IsNullOrEmpty(s.Serial) && s.Serial == d.Serial) ||
                    (!string.IsNullOrEmpty(s.Id) && s.Id == d.Id) ||
                    (!string.IsNullOrEmpty(s.IpAddress) && s.IpAddress == d.IpAddress && s.Port == d.Port));

                if (existing != null)
                {
                    existing.State = d.State;
                    existing.LastConnected = d.LastConnected;
                    existing.FriendlyName = string.IsNullOrEmpty(d.FriendlyName) ? existing.FriendlyName : d.FriendlyName;
                    existing.Serial = d.Serial;
                    if (!string.IsNullOrEmpty(d.IpAddress))
                    {
                        existing.IpAddress = d.IpAddress;
                        existing.Port = d.Port;
                        existing.Transport = "tcpip";
                    }
                }
                else if (d.State == DeviceConnectionState.Connected || d.Transport == "tcpip")
                {
                    c.SavedDevices.Add(new DeviceInfo
                    {
                        Id = d.Id,
                        FriendlyName = d.FriendlyName,
                        Serial = d.Serial,
                        IpAddress = d.IpAddress,
                        Port = d.Port,
                        State = d.State,
                        LastConnected = d.LastConnected,
                        AutoConnect = true,
                        IsPreferred = d.IsPreferred,
                        Transport = d.Transport,
                    });
                }
            }
        });
    }
}
