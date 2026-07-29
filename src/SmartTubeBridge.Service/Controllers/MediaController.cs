using Microsoft.AspNetCore.Mvc;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Controllers;

[ApiController]
[Route("api/media")]
public class MediaController : ControllerBase
{
    private readonly IMediaCommandService _media;

    public MediaController(IMediaCommandService media)
    {
        _media = media;
    }

    private static string? DeviceId(MediaCommand? cmd) => cmd?.DeviceId;

    [HttpPost("play")]
    public async Task<ActionResult<ApiResponse>> Play([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Play, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Play"));
    }

    [HttpPost("pause")]
    public async Task<ActionResult<ApiResponse>> Pause([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Pause, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Pause"));
    }

    [HttpPost("playpause")]
    public async Task<ActionResult<ApiResponse>> PlayPause([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.PlayPause, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Play/Pause toggled"));
    }

    [HttpPost("next")]
    public async Task<ActionResult<ApiResponse>> Next([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Next, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Next"));
    }

    [HttpPost("previous")]
    public async Task<ActionResult<ApiResponse>> Previous([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Previous, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Previous"));
    }

    [HttpPost("forward")]
    public async Task<ActionResult<ApiResponse>> Forward([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.FastForward, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Fast Forward"));
    }

    [HttpPost("rewind")]
    public async Task<ActionResult<ApiResponse>> Rewind([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Rewind, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Rewind"));
    }

    [HttpPost("stop")]
    public async Task<ActionResult<ApiResponse>> Stop([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Stop, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Stop"));
    }

    [HttpPost("volume/up")]
    public async Task<ActionResult<ApiResponse>> VolumeUp([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.VolumeUp, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Volume Up"));
    }

    [HttpPost("volume/down")]
    public async Task<ActionResult<ApiResponse>> VolumeDown([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.VolumeDown, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Volume Down"));
    }

    [HttpPost("volume/mute")]
    public async Task<ActionResult<ApiResponse>> Mute([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Mute, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Mute toggled"));
    }

    [HttpPost("volume")]
    public async Task<ActionResult<ApiResponse>> SetVolume([FromBody] VolumeRequest? request)
    {
        var level = Math.Clamp(request?.Level ?? 0, 0, 15);
        await _media.SetVolumeAsync(level, request?.DeviceId);
        return Ok(ApiResponse.Ok(new { level }, $"Volume set to {level}"));
    }

    [HttpPost("seek")]
    public async Task<ActionResult<ApiResponse>> Seek([FromBody] SeekRequest? request)
    {
        var positionMs = Math.Max(0, request?.PositionMs ?? 0);
        await _media.SeekToAsync(positionMs, request?.DeviceId, request?.VideoId);
        return Ok(ApiResponse.Ok(new { positionMs, videoId = request?.VideoId }, $"Seeked to {positionMs}ms"));
    }

    [HttpGet("position")]
    public async Task<ActionResult<ApiResponse>> GetPosition([FromQuery] string? deviceId = null)
    {
        var pos = await _media.GetPlaybackPositionAsync(deviceId);
        if (pos is null)
            return Ok(ApiResponse.Ok(new { available = false }, "No active media session"));
        return Ok(ApiResponse.Ok(new
        {
            available = true,
            positionMs = pos.PositionMs,
            durationMs = pos.DurationMs,
            isPlaying = pos.IsPlaying,
            package = pos.Package
        }));
    }

    [HttpPost("home")]
    public async Task<ActionResult<ApiResponse>> Home([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Home, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Home"));
    }

    [HttpPost("back")]
    public async Task<ActionResult<ApiResponse>> Back([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Back, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Back"));
    }

    [HttpPost("dpad/up")]
    public async Task<ActionResult<ApiResponse>> DpadUp([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.DpadUp, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Up"));
    }

    [HttpPost("dpad/down")]
    public async Task<ActionResult<ApiResponse>> DpadDown([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.DpadDown, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Down"));
    }

    [HttpPost("dpad/left")]
    public async Task<ActionResult<ApiResponse>> DpadLeft([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.DpadLeft, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Left"));
    }

    [HttpPost("dpad/right")]
    public async Task<ActionResult<ApiResponse>> DpadRight([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.DpadRight, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Right"));
    }

    [HttpPost("dpad/center")]
    public async Task<ActionResult<ApiResponse>> DpadCenter([FromBody] MediaCommand? cmd = null)
    {
        await _media.ExecuteAsync(MediaAction.Center, DeviceId(cmd));
        return Ok(ApiResponse.Ok(message: "Select"));
    }
}

public class VolumeRequest
{
    [System.Text.Json.Serialization.JsonPropertyName("level")]
    public int Level { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("deviceId")]
    public string? DeviceId { get; set; }
}

public class SeekRequest
{
    [System.Text.Json.Serialization.JsonPropertyName("positionMs")]
    public long PositionMs { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("videoId")]
    public string? VideoId { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("deviceId")]
    public string? DeviceId { get; set; }
}
