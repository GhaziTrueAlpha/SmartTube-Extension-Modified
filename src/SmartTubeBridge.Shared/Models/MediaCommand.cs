using SmartTubeBridge.Shared.Enums;

namespace SmartTubeBridge.Shared.Models;

public class MediaCommand
{
    public MediaAction Action { get; set; }
    public string? DeviceId { get; set; }
}

public class CastRequest
{
    public string Url { get; set; } = string.Empty;
    public string? DeviceId { get; set; }
}

public class SearchRequest
{
    public string Query { get; set; } = string.Empty;
    public string? DeviceId { get; set; }
}

public class ApiResponse
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public object? Data { get; set; }
    public string? ErrorCode { get; set; }

    public static ApiResponse Ok(object? data = null, string? message = null) =>
        new() { Success = true, Data = data, Message = message };

    public static ApiResponse Fail(string message, string? code = null) =>
        new() { Success = false, Message = message, ErrorCode = code };
}
