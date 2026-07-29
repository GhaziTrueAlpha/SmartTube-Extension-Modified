using FluentAssertions;
using SmartTubeBridge.Service.Services;
using SmartTubeBridge.Shared.Interfaces;
using Xunit;

namespace SmartTubeBridge.Service.Tests;

public class ConfigServiceTests
{
    [Fact]
    public void GetConfigDirectory_ShouldReturnAppDataPath()
    {
        var log = new ServiceTestsLogService();
        var svc = new ConfigService(log);

        var dir = svc.GetConfigDirectory();
        dir.Should().Contain("SmartTubeBridge");
        dir.Should().Contain("ProgramData");
    }

    [Fact]
    public void Config_Default_ShouldHaveExpectedValues()
    {
        var log = new ServiceTestsLogService();
        var svc = new ConfigService(log);

        var cfg = svc.Config;
        cfg.AdbPath.Should().Be("adb");
        cfg.PackageName.Should().Be("org.smarttube.stable");
        cfg.ApiPort.Should().Be(8765);
        cfg.WakeDelayMs.Should().Be(500);
        cfg.AutoConnect.Should().BeTrue();
    }
}

internal class ServiceTestsLogService : ILogService
{
    public void Debug(string s, string m) { }
    public void Info(string s, string m) { }
    public void Warning(string s, string m) { }
    public void Error(string s, string m, Exception? e = null) { }
    public void Log(SmartTubeBridge.Shared.Enums.LogLevel l, string s, string m, Exception? e = null) { }
    public IReadOnlyList<SmartTubeBridge.Shared.Models.LogEntry> GetRecent(int c = 100) => new List<SmartTubeBridge.Shared.Models.LogEntry>();
    public Task<IReadOnlyList<SmartTubeBridge.Shared.Models.LogEntry>> GetLogsAsync(DateTime? f = null, DateTime? t = null, SmartTubeBridge.Shared.Enums.LogLevel? ml = null, int mr = 500) =>
        Task.FromResult<IReadOnlyList<SmartTubeBridge.Shared.Models.LogEntry>>(new List<SmartTubeBridge.Shared.Models.LogEntry>());
    public Task ClearAsync() => Task.CompletedTask;
    public string GetLogDirectory() => "";
}
