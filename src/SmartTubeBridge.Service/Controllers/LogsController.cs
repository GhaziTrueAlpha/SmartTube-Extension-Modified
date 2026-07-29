using Microsoft.AspNetCore.Mvc;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;
using LogLevel = SmartTubeBridge.Shared.Enums.LogLevel;

namespace SmartTubeBridge.Service.Controllers;

[ApiController]
[Route("api/[controller]")]
public class LogsController : ControllerBase
{
    private readonly ILogService _log;

    public LogsController(ILogService log) => _log = log;

    [HttpGet]
    public async Task<ActionResult<ApiResponse>> Get(
        [FromQuery] DateTime? from, [FromQuery] DateTime? to,
        [FromQuery] LogLevel? level, [FromQuery] int max = 200)
    {
        var entries = await _log.GetLogsAsync(from, to, level, max);
        return Ok(ApiResponse.Ok(entries));
    }

    [HttpDelete("clear")]
    public async Task<ActionResult<ApiResponse>> Clear()
    {
        await _log.ClearAsync();
        return Ok(ApiResponse.Ok(message: "Logs cleared"));
    }
}
