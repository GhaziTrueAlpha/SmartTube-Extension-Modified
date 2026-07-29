using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Shared.Interfaces;

public interface IConfigService
{
    AppConfig Config { get; }
    event EventHandler<AppConfig>? ConfigChanged;

    Task LoadAsync(CancellationToken ct = default);
    Task SaveAsync(CancellationToken ct = default);
    Task UpdateAsync(Action<AppConfig> update, CancellationToken ct = default);
    string GetConfigDirectory();
}
