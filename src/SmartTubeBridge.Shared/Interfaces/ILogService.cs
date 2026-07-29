using SmartTubeBridge.Shared.Models;
using SmartTubeBridge.Shared.Enums;

namespace SmartTubeBridge.Shared.Interfaces;

public interface ILogService
{
    void Debug(string source, string message);
    void Info(string source, string message);
    void Warning(string source, string message);
    void Error(string source, string message, Exception? ex = null);
    void Log(LogLevel level, string source, string message, Exception? ex = null);
    IReadOnlyList<LogEntry> GetRecent(int count = 100);
    Task<IReadOnlyList<LogEntry>> GetLogsAsync(DateTime? from = null, DateTime? to = null,
        LogLevel? minLevel = null, int maxResults = 500);
    Task ClearAsync();
    string GetLogDirectory();
}
