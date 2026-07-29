using Microsoft.AspNetCore.Mvc;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Controllers;

[ApiController]
[Route("api/[controller]")]
public class DeviceController : ControllerBase
{
    private readonly IAdbService _adb;
    private readonly IDeviceManager _devices;
    private readonly IConfigService _config;
    private readonly ILogService _log;

    public DeviceController(IAdbService adb, IDeviceManager devices, IConfigService config, ILogService log)
    {
        _adb = adb;
        _devices = devices;
        _config = config;
        _log = log;
    }

    [HttpGet]
    public async Task<ActionResult<ApiResponse>> List()
    {
        try
        {
            await _devices.RefreshAsync();
        }
        catch (Exception ex)
        {
            _log.Warning("API", $"Device refresh during list failed: {ex.Message}");
        }
        return Ok(ApiResponse.Ok(_devices.KnownDevices));
    }

    [HttpPost("scan")]
    public async Task<ActionResult<ApiResponse>> Scan()
    {
        try
        {
            await _devices.RefreshAsync();
            return Ok(ApiResponse.Ok(_devices.KnownDevices, "Devices scanned"));
        }
        catch (Exception ex)
        {
            _log.Error("API", "Device scan failed", ex);
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }

    [HttpPost("connect")]
    public async Task<ActionResult<ApiResponse>> Connect([FromBody] DeviceConnectRequest request)
    {
        try
        {
            if (!string.IsNullOrEmpty(request.Serial))
            {
                var ok = await _devices.ConnectAsync(request.Serial);
                return ok
                    ? Ok(ApiResponse.Ok(message: "Connected"))
                    : StatusCode(502, ApiResponse.Fail("Failed to connect"));
            }

            if (!string.IsNullOrEmpty(request.Ip))
            {
                var state = await _adb.ConnectDeviceAsync(request.Ip, request.Port);
                await _devices.RefreshAsync();

                if (state == DeviceConnectionState.Connected)
                {
                    var serial = $"{request.Ip}:{request.Port}";
                    var device = _devices.GetBySerial(serial);
                    if (device != null)
                    {
                        device.AutoConnect = true;
                        device.IsPreferred = true;
                        device.FriendlyName = string.IsNullOrEmpty(device.FriendlyName) ? request.Ip : device.FriendlyName;
                        _devices.SetPreferred(device.Id);
                    }

                    await _config.UpdateAsync(c =>
                    {
                        c.PreferredDeviceId = device?.Id;
                        var saved = c.SavedDevices.FirstOrDefault(d => d.Serial == serial);
                        if (saved != null)
                        {
                            saved.AutoConnect = true;
                            saved.IsPreferred = true;
                            saved.LastConnected = DateTime.UtcNow;
                            saved.State = DeviceConnectionState.Connected;
                        }
                        else
                        {
                            c.SavedDevices.Add(new DeviceInfo
                            {
                                Serial = serial,
                                IpAddress = request.Ip,
                                Port = request.Port,
                                Transport = "tcpip",
                                FriendlyName = request.Ip,
                                AutoConnect = true,
                                IsPreferred = true,
                                LastConnected = DateTime.UtcNow,
                                State = DeviceConnectionState.Connected
                            });
                        }
                    });

                    _log.Info("API", $"Device saved for auto-connect: {request.Ip}");
                    return Ok(ApiResponse.Ok(message: $"Connected to {request.Ip}"));
                }

                return StatusCode(502, ApiResponse.Fail($"Connection failed: {state}"));
            }

            return BadRequest(ApiResponse.Fail("Provide serial or IP address"));
        }
        catch (Exception ex)
        {
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }

    [HttpPost("disconnect")]
    public async Task<ActionResult<ApiResponse>> Disconnect([FromBody] DeviceConnectRequest request)
    {
        try
        {
            if (!string.IsNullOrEmpty(request.Serial))
            {
                await _devices.DisconnectAsync(request.Serial);
                return Ok(ApiResponse.Ok(message: "Disconnected"));
            }
            return BadRequest(ApiResponse.Fail("Device serial required"));
        }
        catch (Exception ex)
        {
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }

    [HttpPost("{id}/prefer")]
    public ActionResult<ApiResponse> SetPreferred(string id)
    {
        _devices.SetPreferred(id);
        return Ok(ApiResponse.Ok(message: "Preferred device set"));
    }

    [HttpDelete("{id}")]
    public ActionResult<ApiResponse> Forget(string id)
    {
        _devices.Remove(id);
        return Ok(ApiResponse.Ok(message: "Device removed"));
    }
}

public class DeviceConnectRequest
{
    public string? Serial { get; set; }
    public string? Ip { get; set; }
    public int Port { get; set; } = 5555;
}
