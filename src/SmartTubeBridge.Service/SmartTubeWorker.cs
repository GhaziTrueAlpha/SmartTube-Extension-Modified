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

            // Keep the worker alive until shutdown.
            await Task.Delay(Timeout.Infinite, stoppingToken);
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
