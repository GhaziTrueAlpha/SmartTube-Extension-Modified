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
    Task<VolumeInfo?> GetVolumeAsync(string serial, CancellationToken ct = default);
    Task SeekToAsync(string serial, long positionMs, string videoId, string package, CancellationToken ct = default);
    Task<PlaybackPosition?> GetPlaybackPositionAsync(string serial, CancellationToken ct = default);
    Task<bool> TestConnectionAsync(CancellationToken ct = default);
}

public sealed class VolumeInfo
{
    public int Level { get; set; }
    public int Min { get; set; }
    public int Max { get; set; } = 100;

    /// <summary>Level as 0-100 regardless of the device's native range.</summary>
    public int Percent => Max > Min
        ? (int)Math.Round((Level - Min) * 100.0 / (Max - Min))
        : 0;
}

public sealed class PlaybackPosition
{
    /// <summary>
    /// Position extrapolated to "now": RawPositionMs + StalenessMs * Speed.
    /// This is what callers should use for sync; the raw snapshot can be many
    /// seconds old (82s observed on Acer R4_GTV).
    /// </summary>
    public long PositionMs { get; set; }

    /// <summary>Snapshot value straight from the PlaybackState dump.</summary>
    public long RawPositionMs { get; set; }

    /// <summary>How old the snapshot was when read, in ms (deviceNow - updated).</summary>
    public long StalenessMs { get; set; }

    /// <summary>Playback speed from the dump; 0.0 while paused.</summary>
    public double Speed { get; set; }

    public long DurationMs { get; set; }
    public bool IsPlaying { get; set; }
    public string? Package { get; set; }

    /// <summary>Track title from the media session metadata, when present.</summary>
    public string? Title { get; set; }

    /// <summary>Artist/channel from the media session metadata, when present.</summary>
    public string? Artist { get; set; }
}
