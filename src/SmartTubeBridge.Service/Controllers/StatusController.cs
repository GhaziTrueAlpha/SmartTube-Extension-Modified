using Microsoft.AspNetCore.Mvc;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Controllers;

[ApiController]
[Route("api/[controller]")]
public class StatusController : ControllerBase
{
    private readonly IAdbService _adb;
    private readonly IDeviceManager _devices;
    private readonly IConfigService _config;
    private readonly ILogService _log;

    public StatusController(IAdbService adb, IDeviceManager devices,
        IConfigService config, ILogService log)
    {
        _adb = adb;
        _devices = devices;
        _config = config;
        _log = log;
    }

    [HttpGet]
    public ActionResult<ApiResponse> Get()
    {
        var device = _devices.PreferredDevice ?? _devices.KnownDevices.FirstOrDefault();

        var status = new ServiceStatus
        {
            Version = "1.5.0",
            ServiceRunning = true,
            AdbState = _adb.State,
            DeviceState = device?.State ?? DeviceConnectionState.Disconnected,
            CurrentDevice = device,
            AdbPath = _config.Config.AdbPath,
            PackageName = _config.Config.PackageName,
            WakeDelayMs = _config.Config.WakeDelayMs,
            Uptime = DateTime.UtcNow
        };

        return Ok(ApiResponse.Ok(status));
    }

    [HttpGet("ping")]
    public ActionResult<ApiResponse> Ping() =>
        Ok(ApiResponse.Ok(new { timestamp = DateTime.UtcNow, status = "alive" }));
}
