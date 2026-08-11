using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Interfaces;

namespace SmartTubeBridge.Service;

public class SmartTubeWorker : BackgroundService
{
    private readonly IAdbService _adb;
    private readonly IDeviceManager _devices;
    private readonly IConfigService _config;
    private readonly ILogService _log;

    public SmartTubeWorker(IAdbService adb, IDeviceManager devices,
        IConfigService config, ILogService log)
    {
        _adb = adb;
        _devices = devices;
        _config = config;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Let Kestrel bind first so a port conflict fails cleanly before ADB work.
        await Task.Delay(750, stoppingToken);

        try
        {
            await _config.LoadAsync(stoppingToken);

            _log.Info("Worker", $"ADB path: {_config.Config.AdbPath}");
            _log.Info("Worker", $"Package: {_config.Config.PackageName}");
            _log.Info("Worker", $"API port: {_config.Config.ApiPort}");
            _log.Info("Worker", $"Saved devices: {_config.Config.SavedDevices.Count}");

            try
            {
                await _adb.StartAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _log.Warning("Worker", $"ADB failed to start: {ex.Message}. API still available — configure ADB path in Dashboard.");
            }

            // Always attempt auto-connect regardless of ADB start status
            if (_config.Config.AutoConnect && _config.Config.SavedDevices.Count > 0)
            {
                await Task.Delay(2000, stoppingToken);
                try
                {
                    await _devices.AutoConnectAsync(stoppingToken);
                }
                catch (Exception ex)
                {
                    _log.Warning("Worker", $"Auto-connect failed: {ex.Message}");
                }
            }

            _log.Info("Worker", "SmartTube Bridge Service started successfully");

            await RunReconnectWatchdogAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // normal shutdown
        }
        catch (Exception ex)
        {
            _log.Error("Worker", "Background worker failed", ex);
            // Do not rethrow — keep API alive even if ADB setup failed.
        }
    }

    /// <summary>
    /// ADB-over-TCP drops whenever the TV sleeps, changes network, or the link hiccups, and
    /// nothing brings it back on its own — before this, a single drop meant "TV disconnected"
    /// until someone restarted the service. Poll the device list and reconnect saved devices
    /// whenever nothing is connected.
    /// </summary>
    private async Task RunReconnectWatchdogAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(20);
        var wasConnected = _devices.PreferredDevice?.State == DeviceConnectionState.Connected;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            try
            {
                // Refresh first: `adb devices` is what marks a dead tcpip link as gone.
                await _devices.RefreshAsync(stoppingToken);

                var connected = _devices.KnownDevices.Any(d => d.State == DeviceConnectionState.Connected);

                if (connected)
                {
                    if (!wasConnected)
                        _log.Info("Watchdog", "Device connection restored");
                    wasConnected = true;
                    continue;
                }

                if (wasConnected)
                    _log.Warning("Watchdog", "Device connection lost — attempting to reconnect");
                wasConnected = false;

                if (_config.Config.SavedDevices.Count > 0)
                    await _devices.AutoConnectAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Never let a transient ADB failure kill the watchdog.
                _log.Warning("Watchdog", $"Reconnect attempt failed: {ex.Message}");
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _log.Info("Worker", "SmartTube Bridge Service stopping...");
        try
        {
            await _adb.StopAsync();
        }
        catch (Exception ex)
        {
            _log.Error("Worker", "Error stopping ADB", ex);
        }
        await base.StopAsync(cancellationToken);
    }
}
