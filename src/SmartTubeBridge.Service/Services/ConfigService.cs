using System.Text.Json;
using SmartTubeBridge.Shared.Helpers;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Services;

public class ConfigService : IConfigService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private readonly string _configDir;
    private readonly string _configPath;
    private readonly ILogService _log;
    private readonly object _gate = new();
    private AppConfig _config = new();

    public AppConfig Config => _config;
    public event EventHandler<AppConfig>? ConfigChanged;

    public ConfigService(ILogService log)
    {
        _log = log;
        AppPaths.EnsureInitialized();
        _configDir = AppPaths.DataDirectory;
        _configPath = AppPaths.ConfigPath;
    }

    public async Task LoadAsync(CancellationToken ct = default)
    {
        try
        {
            Directory.CreateDirectory(_configDir);
            if (File.Exists(_configPath))
            {
                var json = await File.ReadAllTextAsync(_configPath, ct);
                _config = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions) ?? new AppConfig();
                _log.Info("Config", $"Configuration loaded ({_config.SavedDevices.Count} saved device(s))");
            }
            else
            {
                _config = new AppConfig();
                await SaveAsync(ct);
                _log.Info("Config", "Default configuration created");
            }
        }
        catch (Exception ex)
        {
            _log.Error("Config", "Failed to load config", ex);
            _config = new AppConfig();
        }
    }

    public async Task SaveAsync(CancellationToken ct = default)
    {
        try
        {
            Directory.CreateDirectory(_configDir);
            string json;
            lock (_gate)
            {
                json = JsonSerializer.Serialize(_config, JsonOptions);
            }
            await File.WriteAllTextAsync(_configPath, json, ct);
        }
        catch (Exception ex)
        {
            _log.Error("Config", "Failed to save config", ex);
        }
    }

    public async Task UpdateAsync(Action<AppConfig> update, CancellationToken ct = default)
    {
        lock (_gate)
        {
            update(_config);
        }
        await SaveAsync(ct);
        ConfigChanged?.Invoke(this, _config);
    }

    public string GetConfigDirectory() => _configDir;
}
