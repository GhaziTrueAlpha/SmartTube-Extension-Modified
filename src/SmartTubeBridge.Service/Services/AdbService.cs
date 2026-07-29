using System.Diagnostics;
using System.Text.RegularExpressions;
using SmartTubeBridge.Shared.Constants;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Exceptions;
using SmartTubeBridge.Shared.Helpers;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Services;

public partial class AdbService : IAdbService, IDisposable
{
    private readonly IConfigService _config;
    private readonly ILogService _log;
    private AdbState _state = AdbState.Stopped;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public AdbState State => _state;

    [GeneratedRegex(@"^([a-f0-9\.:]+)\s+(device|offline|unauthorized|connecting)", RegexOptions.Multiline)]
    private static partial Regex DeviceLinePattern();

    public AdbService(IConfigService config, ILogService log)
    {
        _config = config;
        _log = log;
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            _state = AdbState.Starting;
            _log.Info("ADB", "Starting ADB server...");

            if (!await FindAdbAsync())
                throw new AdbNotFoundException(_config.Config.AdbPath);

            var (exitCode, output) = await RunAsync("start-server", ct);
            if (exitCode != 0)
            {
                _state = AdbState.Error;
                _log.Error("ADB", $"Failed to start ADB server: {output}");
                return;
            }

            _state = AdbState.Running;
            _log.Info("ADB", "ADB server started");
        }
        catch (OperationCanceledException)
        {
            _state = AdbState.Stopped;
            throw;
        }
        catch (Exception ex)
        {
            _state = AdbState.Error;
            _log.Error("ADB", "Failed to start ADB", ex);
            throw;
        }
        finally
        {
            TryReleaseLock();
        }
    }

    public async Task StopAsync()
    {
        await _lock.WaitAsync();
        try
        {
            if (_state == AdbState.Running)
            {
                await RunAsync("kill-server");
                _log.Info("ADB", "ADB server stopped");
            }
            _state = AdbState.Stopped;
        }
        catch (Exception ex)
        {
            _log.Error("ADB", "Error stopping ADB", ex);
        }
        finally
        {
            TryReleaseLock();
        }
    }

    public async Task<string> ExecuteAsync(string[] arguments, CancellationToken ct = default)
    {
        EnsureRunning();
        var (_, output) = await RunAsync(string.Join(" ", arguments.Select(a =>
            a.Contains(' ') ? $"\"{a}\"" : a)), ct);
        return output;
    }

    public async Task<List<DeviceInfo>> ScanDevicesAsync(CancellationToken ct = default)
    {
        var devices = new List<DeviceInfo>();

        try
        {
            // adb devices -l auto-starts the server — no need for explicit EnsureRunning()
            if (!await EnsureAdbAvailableAsync(ct))
            {
                _log.Warning("ADB", "Cannot scan: adb.exe not found or not working");
                return devices;
            }

            var (_, output) = await RunAsync("devices -l", ct);

            var matches = DeviceLinePattern().Matches(output);
            foreach (Match match in matches)
            {
                var serial = match.Groups[1].Value;
                var status = match.Groups[2].Value;

                var device = new DeviceInfo
                {
                    Serial = serial,
                    FriendlyName = serial,
                    State = status switch
                    {
                        "device" => DeviceConnectionState.Connected,
                        "unauthorized" => DeviceConnectionState.Unauthorized,
                        "offline" => DeviceConnectionState.Offline,
                        _ => DeviceConnectionState.Connecting
                    },
                    Transport = serial.Contains(':') ? "tcpip" : "usb",
                    LastConnected = DateTime.UtcNow
                };

                if (device.Transport == "tcpip")
                {
                    var parts = serial.Split(':');
                    device.IpAddress = parts[0];
                    if (parts.Length > 1 && int.TryParse(parts[1], out var port))
                        device.Port = port;
                }

                devices.Add(device);
            }

            if (_state != AdbState.Running)
            {
                _state = AdbState.Running;
                _log.Info("ADB", "ADB server auto-started by device scan");
            }

            _log.Info("ADB", $"Scanned devices: found {devices.Count} device(s)");
        }
        catch (Exception ex)
        {
            _log.Error("ADB", "Failed to scan devices", ex);
        }

        return devices;
    }

    public async Task<bool> EnsureAdbAvailableAsync(CancellationToken ct = default)
    {
        if (_state == AdbState.Running) return true;

        if (!await FindAdbAsync())
            return false;

        try
        {
            var (exitCode, _) = await RunAsync("start-server", ct);
            if (exitCode == 0)
            {
                _state = AdbState.Running;
                return true;
            }
        }
        catch { }

        return false;
    }

    public async Task<DeviceConnectionState> ConnectDeviceAsync(string ip, int port = 5555, CancellationToken ct = default)
    {
        if (!await EnsureAdbAvailableAsync(ct))
        {
            _log.Error("ADB", "Cannot connect: adb.exe not found or not working");
            return DeviceConnectionState.Disconnected;
        }

        try
        {
            _log.Info("ADB", $"Connecting to {ip}:{port}...");
            var (exitCode, output) = await RunAsync($"connect {ip}:{port}", ct);

            if (output.Contains("connected") || output.Contains("already connected"))
            {
                _log.Info("ADB", $"Transport connected to {ip}:{port}, waiting for authorization...");

                var serial = $"{ip}:{port}";
                var authorized = await PollForAuthorizationAsync(serial, ct);

                if (authorized)
                {
                    _log.Info("ADB", $"Device {ip}:{port} authorized and connected");
                    return DeviceConnectionState.Connected;
                }

                _log.Warning("ADB", $"Device {ip}:{port} connected but NOT authorized. Check the TV screen for the 'Allow USB debugging?' prompt and accept it, then reconnect.");
                return DeviceConnectionState.Unauthorized;
            }

            if (output.Contains("unable") || output.Contains("refused"))
            {
                _log.Warning("ADB", $"Connection to {ip}:{port} refused");
                return DeviceConnectionState.NotFound;
            }

            _log.Warning("ADB", $"Connection to {ip}:{port} gave: {output.Trim()}");
            return DeviceConnectionState.Disconnected;
        }
        catch (Exception ex)
        {
            _log.Error("ADB", $"Connection error to {ip}:{port}", ex);
            return DeviceConnectionState.Disconnected;
        }
    }

    private async Task<bool> PollForAuthorizationAsync(string serial, CancellationToken ct, int maxWaitMs = 15000)
    {
        var attempts = maxWaitMs / 500;
        for (int i = 0; i < attempts; i++)
        {
            await Task.Delay(500, ct);
            var (_, output) = await RunAsync("devices -l", ct);
            foreach (Match match in DeviceLinePattern().Matches(output))
            {
                if (match.Groups[1].Value == serial)
                    return match.Groups[2].Value == "device";
            }
        }
        return false;
    }

    public async Task DisconnectDeviceAsync(string serial, CancellationToken ct = default)
    {
        if (!await EnsureAdbAvailableAsync(ct)) return;
        await RunAsync($"disconnect {serial}", ct);
        _log.Info("ADB", $"Disconnected {serial}");
    }

    public async Task SendKeyEventAsync(string serial, int keyCode, CancellationToken ct = default)
    {
        EnsureRunning();
        await RunAsync($"-s {serial} shell input keyevent {keyCode}", ct);
    }

    public async Task OpenUrlAsync(string serial, string url, string package, CancellationToken ct = default)
    {
        EnsureRunning();

        var videoId = YouTubeUrlHelper.ExtractVideoId(url);
        var packages = BuildPackageCandidates(package);
        var attempts = new List<string>();

        foreach (var pkg in packages)
        {
            if (!string.IsNullOrEmpty(videoId))
            {
                // Best documented SmartTube launches (issue #1999 + upstream).
                attempts.Add(
                    $"am start -a android.intent.action.VIEW -d 'vnd.youtube://{videoId}' -n {pkg}/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity");
                attempts.Add(
                    $"am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v={videoId}' -n {pkg}/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity");
                attempts.Add(
                    $"am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v={videoId}' -p {pkg}");
            }
            else
            {
                var openUrl = url.Replace("'", "'\\''");
                attempts.Add(
                    $"am start -a android.intent.action.VIEW -d '{openUrl}' -n {pkg}/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity");
                attempts.Add(
                    $"am start -a android.intent.action.VIEW -d '{openUrl}' -p {pkg}");
            }
        }

        foreach (var remote in attempts.Distinct())
        {
            var (exitCode, output) = await RunAsync(
                $"-s {serial} shell {QuoteForAdbShell(remote)}", ct);

            var ok = exitCode == 0
                && output.Contains("Starting: Intent", StringComparison.OrdinalIgnoreCase)
                && !output.Contains("Error type", StringComparison.OrdinalIgnoreCase)
                && !output.Contains("does not exist", StringComparison.OrdinalIgnoreCase)
                && !output.Contains("unable to resolve", StringComparison.OrdinalIgnoreCase)
                && !output.Contains("inaccessible", StringComparison.OrdinalIgnoreCase);

            if (ok)
            {
                _log.Info("ADB", $"Opened URL on {serial} via SmartTube: {videoId ?? url}");
                return;
            }

            _log.Warning("ADB", $"OpenUrl attempt failed ({exitCode}): {output.Trim()}");
        }

        throw new SmartTubeBridgeException(
            "Failed to open URL in SmartTube. Check the package name in settings.",
            "CAST_FAILED");
    }

    private static IEnumerable<string> BuildPackageCandidates(string? configured)
    {
        var list = new List<string>();
        void Add(string? p)
        {
            if (!string.IsNullOrWhiteSpace(p) && !list.Contains(p, StringComparer.OrdinalIgnoreCase))
                list.Add(p.Trim());
        }

        Add(configured);
        Add("org.smarttube.stable");
        Add("com.teamsmart.videomanager.tv");
        Add("org.smarttube.beta");
        Add("com.liskovsoft.smarttubetv.beta");
        return list;
    }

    private static string QuoteForAdbShell(string remoteCommand)
    {
        // adb shell "…" — escape embedded double quotes for ProcessStartInfo/Windows.
        return "\"" + remoteCommand.Replace("\"", "\\\"") + "\"";
    }

    public async Task WakeDeviceAsync(string serial, CancellationToken ct = default)
    {
        EnsureRunning();
        await RunAsync($"-s {serial} shell input keyevent {KeyCodes.WakeUp}", ct);
        await Task.Delay(_config.Config.WakeDelayMs, ct);
    }

    public async Task SetVolumeAsync(string serial, int level, CancellationToken ct = default)
    {
        EnsureRunning();
        level = Math.Clamp(level, 0, 15);

        // Try common Android TV absolute-volume commands (MUSIC stream = 3).
        var commands = new[]
        {
            $"cmd media_session volume --show --stream 3 --set {level}",
            $"cmd media volume --show --stream 3 --set {level}",
            $"media volume --show --stream 3 --set {level}",
            $"settings put system volume_music_speaker {level}",
            $"settings put system volume_music {level}",
        };

        foreach (var shellCmd in commands)
        {
            var (exitCode, output) = await RunAsync($"-s {serial} shell {shellCmd}", ct);
            if (exitCode == 0 && !LooksLikeVolumeFailure(output))
            {
                _log.Info("ADB", $"Set volume on {serial} to {level} via: {shellCmd}");
                return;
            }
        }

        _log.Warning("ADB", $"Absolute volume failed on {serial}; stepping with keyevents to {level}");
        for (var i = 0; i < 16; i++)
            await SendKeyEventAsync(serial, KeyCodes.VolumeDown, ct);
        for (var i = 0; i < level; i++)
            await SendKeyEventAsync(serial, KeyCodes.VolumeUp, ct);
    }

    private static bool LooksLikeVolumeFailure(string output)
    {
        if (string.IsNullOrWhiteSpace(output)) return false;
        return output.Contains("Unknown command", StringComparison.OrdinalIgnoreCase)
            || output.Contains("not found", StringComparison.OrdinalIgnoreCase)
            || output.Contains("No such file", StringComparison.OrdinalIgnoreCase)
            || output.Contains("Exception", StringComparison.OrdinalIgnoreCase)
            || output.Contains("Usage:", StringComparison.OrdinalIgnoreCase);
    }

    public async Task SeekToAsync(string serial, long positionMs, string videoId, string package, CancellationToken ct = default)
    {
        EnsureRunning();
        positionMs = Math.Max(0, positionMs);
        var seconds = (int)(positionMs / 1000);

        // Absolute seek_to is NOT supported by media_session on Android TV.
        // SmartTube honors YouTube timestamps via SplashActivity VIEW intents.
        var packages = BuildPackageCandidates(package);
        var attempts = new List<string>();
        foreach (var pkg in packages)
        {
            attempts.Add(
                $"am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v={videoId}&t={seconds}' -n {pkg}/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity");
            attempts.Add(
                $"am start -a android.intent.action.VIEW -d 'vnd.youtube://{videoId}?t={seconds}' -n {pkg}/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity");
            attempts.Add(
                $"am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v={videoId}&t={seconds}s' -p {pkg}");
        }

        foreach (var remote in attempts.Distinct())
        {
            var (exitCode, output) = await RunAsync(
                $"-s {serial} shell {QuoteForAdbShell(remote)}", ct);

            var ok = exitCode == 0
                && output.Contains("Starting: Intent", StringComparison.OrdinalIgnoreCase)
                && !output.Contains("Error type", StringComparison.OrdinalIgnoreCase)
                && !output.Contains("does not exist", StringComparison.OrdinalIgnoreCase);

            if (ok)
            {
                _log.Info("ADB", $"Seeked {serial} to {seconds}s via SmartTube intent ({videoId})");
                return;
            }
        }

        throw new SmartTubeBridgeException(
            $"Failed to seek SmartTube to {seconds}s.", "SEEK_FAILED");
    }

    public async Task<PlaybackPosition?> GetPlaybackPositionAsync(string serial, CancellationToken ct = default)
    {
        EnsureRunning();
        var (_, output) = await RunAsync(
            $"-s {serial} shell {QuoteForAdbShell("dumpsys media_session")}", ct);

        if (string.IsNullOrWhiteSpace(output))
            return null;

        // Prefer SmartTube's media session, then any PlaybackState.
        var lines = output.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (!lines[i].Contains("package=org.smarttube", StringComparison.OrdinalIgnoreCase) &&
                !lines[i].Contains("package=com.teamsmart.videomanager", StringComparison.OrdinalIgnoreCase) &&
                !lines[i].Contains("package=com.liskovsoft", StringComparison.OrdinalIgnoreCase))
                continue;

            // Search nearby for PlaybackState
            for (var j = i; j < Math.Min(i + 25, lines.Length); j++)
            {
                if (!lines[j].Contains("state=PlaybackState", StringComparison.OrdinalIgnoreCase))
                    continue;

                var position = ParsePlaybackPosition(lines[j]);
                if (position is null) continue;

                var isPlaying = lines[j].Contains("PLAYING", StringComparison.OrdinalIgnoreCase)
                    || lines[j].Contains("state=3")
                    || lines[j].Contains("(3)");
                var buffering = lines[j].Contains("BUFFERING", StringComparison.OrdinalIgnoreCase);

                return new PlaybackPosition
                {
                    PositionMs = Math.Max(0, position.Value),
                    DurationMs = 0,
                    IsPlaying = isPlaying || buffering,
                    Package = lines[i].Contains("org.smarttube", StringComparison.OrdinalIgnoreCase)
                        ? "org.smarttube.stable"
                        : null
                };
            }
        }

        // Fallback: first PlaybackState with a non-zero/reasonable position
        foreach (var line in lines)
        {
            if (!line.Contains("state=PlaybackState", StringComparison.OrdinalIgnoreCase))
                continue;
            var position = ParsePlaybackPosition(line);
            if (position is null || position < 0) continue;
            return new PlaybackPosition
            {
                PositionMs = position.Value,
                DurationMs = 0,
                IsPlaying = line.Contains("PLAYING", StringComparison.OrdinalIgnoreCase),
                Package = null
            };
        }

        return null;
    }

    private static long? ParsePlaybackPosition(string line)
    {
        // Supports: position=120000  or  position=-37
        var m = Regex.Match(line, @"position=(-?\d+)");
        if (!m.Success) return null;
        if (!long.TryParse(m.Groups[1].Value, out var v)) return null;
        return v < 0 ? 0 : v;
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct = default)
    {
        try
        {
            var (exitCode, _) = await RunAsync("version", ct);
            return exitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private void TryReleaseLock()
    {
        try
        {
            if (Volatile.Read(ref _disposed) == 0)
                _lock.Release();
        }
        catch (ObjectDisposedException) { }
        catch (SemaphoreFullException) { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { _lock.Dispose(); } catch { }
    }

    private int _disposed;

    private void EnsureRunning()
    {
        if (_state != AdbState.Running)
            throw new SmartTubeBridgeException("ADB is not running. Start the service first.", "ADB_NOT_RUNNING");
    }

    private async Task<bool> FindAdbAsync()
    {
        var path = _config.Config.AdbPath;
        if (string.IsNullOrWhiteSpace(path)) path = "adb";

        // Respect user-saved ADB path — only auto-detect when still default
        if (!AdbPathHelper.IsDefaultPath(path))
        {
            if (AdbPathHelper.IsValidPath(path))
            {
                _log.Info("ADB", $"Using saved ADB path: {path}");
                return true;
            }
            _log.Warning("ADB", $"Saved ADB path not found: {path}");
            return false;
        }

        var fromPath = AdbPathHelper.FindOnPath();
        if (fromPath != null)
        {
            await _config.UpdateAsync(c => c.AdbPath = fromPath);
            _log.Info("ADB", $"Auto-detected ADB on PATH: {fromPath}");
            return true;
        }

        foreach (var p in AdbPathHelper.DefaultSdkPaths)
        {
            if (File.Exists(p))
            {
                await _config.UpdateAsync(c => c.AdbPath = p);
                _log.Info("ADB", $"Auto-detected ADB in SDK: {p}");
                return true;
            }
        }

        return false;
    }

    private static string? FindOnPath(string exe) => AdbPathHelper.FindOnPath(exe);

    private async Task<(int exitCode, string output)> RunAsync(string args, CancellationToken ct = default)
    {
        var adbPath = _config.Config.AdbPath;
        if (string.IsNullOrWhiteSpace(adbPath)) adbPath = "adb";

        var psi = new ProcessStartInfo
        {
            FileName = adbPath,
            Arguments = args,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var proc = new Process { StartInfo = psi };
        proc.Start();

        var outTask = proc.StandardOutput.ReadToEndAsync(ct);
        var errTask = proc.StandardError.ReadToEndAsync(ct);

        await proc.WaitForExitAsync(ct);

        var output = await outTask;
        var error = await errTask;

        _log.Debug("ADB", $"> {adbPath} {args}");
        if (!string.IsNullOrEmpty(error))
            _log.Debug("ADB", $"stderr: {error.Trim()}");

        return (proc.ExitCode, string.IsNullOrEmpty(error) ? output : output + Environment.NewLine + error);
    }
}
