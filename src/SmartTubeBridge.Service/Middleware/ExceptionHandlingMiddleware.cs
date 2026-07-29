using System.Net;
using System.Text.Json;
using SmartTubeBridge.Shared.Exceptions;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Middleware;

public class ExceptionHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogService _log;

    public ExceptionHandlingMiddleware(RequestDelegate next, ILogService log)
    {
        _next = next;
        _log = log;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (SmartTubeBridgeException ex)
        {
            _log.Warning("API", $"App error: {ex.Message} [{ex.ErrorCode}]");
            await WriteErrorResponse(context, HttpStatusCode.BadRequest, ex.Message, ex.ErrorCode);
        }
        catch (UnauthorizedAccessException ex)
        {
            _log.Warning("API", "Unauthorized access attempt");
            await WriteErrorResponse(context, HttpStatusCode.Forbidden, ex.Message, "FORBIDDEN");
        }
        catch (OperationCanceledException)
        {
            _log.Info("API", "Request cancelled");
            context.Response.StatusCode = 499;
        }
        catch (Exception ex)
        {
            _log.Error("API", "Unhandled exception", ex);
            await WriteErrorResponse(context, HttpStatusCode.InternalServerError,
                "An internal error occurred", "INTERNAL_ERROR");
        }
    }

    private static async Task WriteErrorResponse(HttpContext context, HttpStatusCode statusCode,
        string message, string errorCode)
    {
        context.Response.ContentType = "application/json";
        context.Response.StatusCode = (int)statusCode;

        var response = ApiResponse.Fail(message, errorCode);
        var json = JsonSerializer.Serialize(response);
        await context.Response.WriteAsync(json);
    }
}
