using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Shared.Interfaces;

public interface IAdbService
{
    AdbState State { get; }
    Task StartAsync(CancellationToken ct);
    Task StopAsync();
    Task<string> ExecuteAsync(string[] arguments, CancellationToken ct = default);
    Task<List<DeviceInfo>> ScanDevicesAsync(CancellationToken ct = default);
    Task<bool> EnsureAdbAvailableAsync(CancellationToken ct = default);
    Task<DeviceConnectionState> ConnectDeviceAsync(string ip, int port = 5555, CancellationToken ct = default);
    Task DisconnectDeviceAsync(string serial, CancellationToken ct = default);
    Task SendKeyEventAsync(string serial, int keyCode, CancellationToken ct = default);
    Task OpenUrlAsync(string serial, string url, string package, CancellationToken ct = default);
    Task WakeDeviceAsync(string serial, CancellationToken ct = default);
    Task SetVolumeAsync(string serial, int level, CancellationToken ct = default);
    Task SeekToAsync(string serial, long positionMs, string videoId, string package, CancellationToken ct = default);
    Task<PlaybackPosition?> GetPlaybackPositionAsync(string serial, CancellationToken ct = default);
    Task<bool> TestConnectionAsync(CancellationToken ct = default);
}

public sealed class PlaybackPosition
{
    public long PositionMs { get; set; }
    public long DurationMs { get; set; }
    public bool IsPlaying { get; set; }
    public string? Package { get; set; }
}
