using Microsoft.AspNetCore.Mvc;
using SmartTubeBridge.Shared.Helpers;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SettingsController : ControllerBase
{
    private readonly IConfigService _config;
    private readonly ILogService _log;

    public SettingsController(IConfigService config, ILogService log)
    {
        _config = config;
        _log = log;
    }

    [HttpGet]
    public ActionResult<ApiResponse> Get() =>
        Ok(ApiResponse.Ok(_config.Config));

    [HttpPost]
    public async Task<ActionResult<ApiResponse>> Update([FromBody] AppConfig update)
    {
        try
        {
            await _config.UpdateAsync(c =>
            {
                if (!string.IsNullOrEmpty(update.AdbPath))
                    c.AdbPath = update.AdbPath;
                if (!string.IsNullOrEmpty(update.PackageName))
                    c.PackageName = update.PackageName;
                if (update.WakeDelayMs > 0)
                    c.WakeDelayMs = update.WakeDelayMs;
                c.AutoConnect = update.AutoConnect;
                c.LaunchAtStartup = update.LaunchAtStartup;
                c.EnableFloatingButton = update.EnableFloatingButton;
                c.EnableContextMenu = update.EnableContextMenu;
                if (update.RetryBaseDelayMs > 0)
                    c.RetryBaseDelayMs = update.RetryBaseDelayMs;
                if (update.RetryMaxAttempts > 0)
                    c.RetryMaxAttempts = update.RetryMaxAttempts;
                if (update.SavedDevices is { Count: > 0 })
                    c.SavedDevices = update.SavedDevices;
            });

            _log.Info("API", "Settings updated");
            return Ok(ApiResponse.Ok(_config.Config, "Settings saved"));
        }
        catch (Exception ex)
        {
            _log.Error("API", "Failed to update settings", ex);
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }

    [HttpGet("adb/candidates")]
    public ActionResult<ApiResponse> GetAdbCandidates()
    {
        var candidates = AdbPathHelper.DiscoverCandidates();
        return Ok(ApiResponse.Ok(new
        {
            current = _config.Config.AdbPath,
            candidates
        }));
    }

    [HttpPost("adb/test")]
    public async Task<ActionResult<ApiResponse>> TestAdb([FromBody] AdbTestRequest request, CancellationToken ct)
    {
        var path = string.IsNullOrWhiteSpace(request.Path) ? _config.Config.AdbPath : request.Path;
        if (!AdbPathHelper.IsValidPath(path))
            return BadRequest(ApiResponse.Fail($"ADB not found: {path}"));

        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = path,
                Arguments = "version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var proc = System.Diagnostics.Process.Start(psi);
            if (proc == null)
                return StatusCode(500, ApiResponse.Fail("Failed to start ADB process"));

            var output = await proc.StandardOutput.ReadToEndAsync(ct);
            await proc.WaitForExitAsync(ct);

            if (proc.ExitCode != 0)
                return StatusCode(502, ApiResponse.Fail("ADB test failed"));

            if (request.Save)
            {
                await _config.UpdateAsync(c => c.AdbPath = path, ct);
                _log.Info("API", $"ADB path saved: {path}");
            }

            return Ok(ApiResponse.Ok(new { path, version = output.Trim() }, request.Save ? "ADB path saved" : "ADB OK"));
        }
        catch (Exception ex)
        {
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }
}

public class AdbTestRequest
{
    public string? Path { get; set; }
    public bool Save { get; set; }
}
