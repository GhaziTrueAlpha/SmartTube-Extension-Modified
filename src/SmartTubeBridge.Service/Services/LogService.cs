using System.Collections.Concurrent;
using System.Text.Json;
using SmartTubeBridge.Shared.Helpers;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;
using LogLevel = SmartTubeBridge.Shared.Enums.LogLevel;

namespace SmartTubeBridge.Service.Services;

public class LogService : ILogService
{
    private readonly string _logDir;
    private readonly ConcurrentQueue<LogEntry> _recent = new();
    private readonly object _writeLock = new();
    private const int MaxRecentEntries = 500;

    public LogService()
    {
        AppPaths.EnsureInitialized();
        _logDir = AppPaths.LogsDirectory;
    }

    public void Debug(string source, string message) => Log(LogLevel.Debug, source, message);
    public void Info(string source, string message) => Log(LogLevel.Info, source, message);
    public void Warning(string source, string message) => Log(LogLevel.Warning, source, message);
    public void Error(string source, string message, Exception? ex = null) => Log(LogLevel.Error, source, message, ex);

    public void Log(LogLevel level, string source, string message, Exception? ex = null)
    {
        var entry = new LogEntry
        {
            Timestamp = DateTime.UtcNow,
            Level = level,
            Source = source,
            Message = message,
            Exception = ex?.ToString()
        };

        _recent.Enqueue(entry);
        while (_recent.Count > MaxRecentEntries)
            _recent.TryDequeue(out _);

        WriteToFile(entry);
        WriteToConsole(entry);
    }

    public IReadOnlyList<LogEntry> GetRecent(int count = 100) =>
        _recent.Reverse().Take(count).ToList().AsReadOnly();

    public async Task<IReadOnlyList<LogEntry>> GetLogsAsync(
        DateTime? from = null, DateTime? to = null,
        LogLevel? minLevel = null, int maxResults = 500)
    {
        var entries = new List<LogEntry>();
        var files = Directory.GetFiles(_logDir, "*.log")
            .OrderByDescending(f => f)
            .Take(10);

        foreach (var file in files)
        {
            try
            {
                var lines = await File.ReadAllLinesAsync(file);
                foreach (var line in lines.Reverse())
                {
                    try
                    {
                        var entry = JsonSerializer.Deserialize<LogEntry>(line);
                        if (entry != null) entries.Add(entry);
                    }
                    catch { }
                }
            }
            catch { }
        }

        return entries
            .Where(e =>
                (!from.HasValue || e.Timestamp >= from.Value) &&
                (!to.HasValue || e.Timestamp <= to.Value) &&
                (!minLevel.HasValue || e.Level >= minLevel.Value))
            .Take(maxResults)
            .ToList()
            .AsReadOnly();
    }

    public Task ClearAsync()
    {
        while (_recent.TryDequeue(out _)) { }
        foreach (var f in Directory.GetFiles(_logDir, "*.log"))
        {
            try { File.Delete(f); } catch { }
        }
        return Task.CompletedTask;
    }

    public string GetLogDirectory() => _logDir;

    private void WriteToFile(LogEntry entry)
    {
        lock (_writeLock)
        {
            var date = entry.Timestamp.ToString("yyyy-MM-dd");
            var path = Path.Combine(_logDir, $"smarttube-{date}.log");
            var json = JsonSerializer.Serialize(entry);
            File.AppendAllText(path, json + Environment.NewLine);
        }
    }

    private void WriteToConsole(LogEntry entry)
    {
        if (!Environment.UserInteractive) return;
        try
        {
            var color = entry.Level switch
            {
                LogLevel.Error => ConsoleColor.Red,
                LogLevel.Warning => ConsoleColor.Yellow,
                LogLevel.Info => ConsoleColor.Green,
                _ => ConsoleColor.Gray
            };
            Console.ForegroundColor = color;
            Console.WriteLine($"[{entry.Timestamp:HH:mm:ss}] [{entry.Level}] [{entry.Source}] {entry.Message}");
            Console.ResetColor();
        }
        catch
        {
        }
    }
}
