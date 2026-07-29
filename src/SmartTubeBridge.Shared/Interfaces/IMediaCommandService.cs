using SmartTubeBridge.Shared.Enums;

using PlaybackPosition = SmartTubeBridge.Shared.Interfaces.PlaybackPosition;

namespace SmartTubeBridge.Shared.Interfaces;

public interface IMediaCommandService
{
    Task ExecuteAsync(MediaAction action, string? deviceId = null, CancellationToken ct = default);
    Task CastUrlAsync(string url, string? deviceId = null, CancellationToken ct = default);
    Task SearchAsync(string query, string? deviceId = null, CancellationToken ct = default);
    Task SetVolumeAsync(int level, string? deviceId = null, CancellationToken ct = default);
    Task SeekToAsync(long positionMs, string? deviceId = null, string? videoId = null, CancellationToken ct = default);
    Task<PlaybackPosition?> GetPlaybackPositionAsync(string? deviceId = null, CancellationToken ct = default);
}
