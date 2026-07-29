using SmartTubeBridge.Shared.Constants;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Exceptions;
using SmartTubeBridge.Shared.Helpers;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Services;

public class MediaCommandService : IMediaCommandService
{
    private readonly IAdbService _adb;
    private readonly IDeviceManager _devices;
    private readonly IConfigService _config;
    private readonly ILogService _log;

    private static readonly Dictionary<MediaAction, int> ActionKeyCodes = new()
    {
        [MediaAction.Play] = KeyCodes.MediaPlay,
        [MediaAction.Pause] = KeyCodes.MediaPause,
        [MediaAction.PlayPause] = KeyCodes.MediaPlayPause,
        [MediaAction.Next] = KeyCodes.MediaNext,
        [MediaAction.Previous] = KeyCodes.MediaPrevious,
        [MediaAction.FastForward] = KeyCodes.MediaFastForward,
        [MediaAction.Rewind] = KeyCodes.MediaRewind,
        [MediaAction.Stop] = KeyCodes.MediaStop,
        [MediaAction.VolumeUp] = KeyCodes.VolumeUp,
        [MediaAction.VolumeDown] = KeyCodes.VolumeDown,
        [MediaAction.Mute] = KeyCodes.Mute,
        [MediaAction.Home] = KeyCodes.Home,
        [MediaAction.Back] = KeyCodes.Back,
        [MediaAction.DpadUp] = KeyCodes.DpadUp,
        [MediaAction.DpadDown] = KeyCodes.DpadDown,
        [MediaAction.DpadLeft] = KeyCodes.DpadLeft,
        [MediaAction.DpadRight] = KeyCodes.DpadRight,
        [MediaAction.Center] = KeyCodes.DpadCenter,
        [MediaAction.Menu] = KeyCodes.Menu,
        [MediaAction.Search] = KeyCodes.Search,
        [MediaAction.Settings] = KeyCodes.Settings,
        [MediaAction.Power] = KeyCodes.Power,
        [MediaAction.Sleep] = KeyCodes.Sleep,
    };

    public MediaCommandService(IAdbService adb, IDeviceManager devices,
        IConfigService config, ILogService log)
    {
        _adb = adb;
        _devices = devices;
        _config = config;
        _log = log;
    }

    public async Task ExecuteAsync(MediaAction action, string? deviceId = null, CancellationToken ct = default)
    {
        var device = ResolveDevice(deviceId);
        if (device == null)
            throw new DeviceNotConnectedException("No device connected");

        _log.Info("Media", $"Executing {action} on {device.FriendlyName}");

        if (action is MediaAction.Power or MediaAction.Sleep or MediaAction.PlayPause or MediaAction.Play or MediaAction.Pause or MediaAction.Next or MediaAction.Previous or MediaAction.FastForward or MediaAction.Rewind or MediaAction.Stop)
        {
            await _adb.WakeDeviceAsync(device.Serial, ct);
        }

        if (ActionKeyCodes.TryGetValue(action, out var keyCode))
        {
            await _adb.SendKeyEventAsync(device.Serial, keyCode, ct);
        }
    }

    private string? _lastVideoId;

    public async Task CastUrlAsync(string url, string? deviceId = null, CancellationToken ct = default)
    {
        var normalized = YouTubeUrlHelper.Normalize(url);

        if (!YouTubeUrlHelper.IsYouTubeUrl(normalized))
            throw new InvalidUrlException(url);

        var device = ResolveDevice(deviceId);
        if (device == null)
            throw new DeviceNotConnectedException("No device connected");

        _lastVideoId = YouTubeUrlHelper.ExtractVideoId(normalized);
        _log.Info("Media", $"Casting URL to {device.FriendlyName}: {normalized}");

        await _adb.WakeDeviceAsync(device.Serial, ct);
        await _adb.OpenUrlAsync(device.Serial, normalized, _config.Config.PackageName, ct);
    }

    public async Task SearchAsync(string query, string? deviceId = null, CancellationToken ct = default)
    {
        var encoded = Uri.EscapeDataString(query);
        var url = $"https://www.youtube.com/results?search_query={encoded}";
        await CastUrlAsync(url, deviceId, ct);
    }

    public async Task SetVolumeAsync(int level, string? deviceId = null, CancellationToken ct = default)
    {
        var device = ResolveDevice(deviceId);
        if (device == null)
            throw new DeviceNotConnectedException("No device connected");

        _log.Info("Media", $"Setting volume to {level} on {device.FriendlyName}");
        await _adb.SetVolumeAsync(device.Serial, level, ct);
    }

    public async Task SeekToAsync(long positionMs, string? deviceId = null, string? videoId = null, CancellationToken ct = default)
    {
        var device = ResolveDevice(deviceId);
        if (device == null)
            throw new DeviceNotConnectedException("No device connected");

        positionMs = Math.Max(0, positionMs);
        var id = !string.IsNullOrWhiteSpace(videoId) ? videoId.Trim() : _lastVideoId;
        if (string.IsNullOrEmpty(id))
            throw new SmartTubeBridgeException(
                "No active cast video to seek. Cast a video first.", "NO_CAST_VIDEO");

        _lastVideoId = id;
        _log.Info("Media", $"Seeking video {id} to {positionMs}ms on {device.FriendlyName}");
        await _adb.SeekToAsync(device.Serial, positionMs, id, _config.Config.PackageName, ct);
    }

    public async Task<PlaybackPosition?> GetPlaybackPositionAsync(string? deviceId = null, CancellationToken ct = default)
    {
        var device = ResolveDevice(deviceId);
        if (device == null)
            return null;

        return await _adb.GetPlaybackPositionAsync(device.Serial, ct);
    }

    private DeviceInfo? ResolveDevice(string? deviceId)
    {
        if (!string.IsNullOrEmpty(deviceId))
            return _devices.GetById(deviceId) ?? _devices.GetBySerial(deviceId);
        return _devices.PreferredDevice;
    }
}
