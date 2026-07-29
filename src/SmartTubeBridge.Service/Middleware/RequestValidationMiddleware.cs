using System.Net;
using System.Text.RegularExpressions;
using SmartTubeBridge.Shared.Interfaces;

namespace SmartTubeBridge.Service.Middleware;

public partial class RequestValidationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogService _log;

    [GeneratedRegex(@"^https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com|music\.youtube\.com)(\/|$)", RegexOptions.IgnoreCase)]
    private static partial Regex YoutubeUrlPattern();

    public RequestValidationMiddleware(RequestDelegate next, ILogService log)
    {
        _next = next;
        _log = log;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var remote = context.Connection.RemoteIpAddress;
        if (!IsLocalAddress(remote))
        {
            _log.Warning("Security", $"Blocked request from external IP: {remote}");
            context.Response.StatusCode = 403;
            return;
        }

        if (context.Request.Method == "POST" && context.Request.ContentLength > 0)
        {
            context.Request.EnableBuffering();
            using var reader = new StreamReader(context.Request.Body, leaveOpen: true);
            var body = await reader.ReadToEndAsync();
            context.Request.Body.Position = 0;

            if (!IsBodySafe(body))
            {
                _log.Warning("Security", $"Blocked request with unsafe payload from {remote}");
                context.Response.StatusCode = 400;
                return;
            }
        }

        await _next(context);
    }

    private static bool IsLocalAddress(IPAddress? ip)
    {
        if (ip is null) return true;
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.IsIPv4MappedToIPv6)
            return IPAddress.IsLoopback(ip.MapToIPv4());
        return false;
    }

    private static bool IsBodySafe(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return true;
        if (body.Length > 100_000) return false;

        try
        {
            var doc = System.Text.Json.JsonDocument.Parse(body);
            return ValidateJsonNode(doc.RootElement);
        }
        catch
        {
            return false;
        }
    }

    private static bool ValidateJsonNode(System.Text.Json.JsonElement element)
    {
        return element.ValueKind switch
        {
            System.Text.Json.JsonValueKind.String => ValidateString(element.GetString() ?? ""),
            System.Text.Json.JsonValueKind.Object => element.EnumerateObject().All(p => ValidateJsonNode(p.Value)),
            System.Text.Json.JsonValueKind.Array => element.EnumerateArray().All(ValidateJsonNode),
            _ => true
        };
    }

    private static bool ValidateString(string value)
    {
        if (string.IsNullOrEmpty(value)) return true;

        // Only apply URL SSRF checks to http(s) URLs — not Windows paths like C:\...
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase) ||
             uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)))
        {
            if (YoutubeUrlPattern().IsMatch(value)) return true;
            return !string.IsNullOrEmpty(uri.Host)
                && !uri.Host.Contains("127.0.0.1", StringComparison.OrdinalIgnoreCase)
                && !uri.Host.Contains("localhost", StringComparison.OrdinalIgnoreCase)
                && !uri.Host.Contains("internal", StringComparison.OrdinalIgnoreCase)
                && !uri.Host.Contains("private", StringComparison.OrdinalIgnoreCase);
        }

        return !value.Contains("&&") && !value.Contains("||")
            && !value.Contains("`") && !value.Contains("$(");
    }
}
