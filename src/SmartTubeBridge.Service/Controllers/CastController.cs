using Microsoft.AspNetCore.Mvc;
using SmartTubeBridge.Service.Services;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Service.Controllers;

[ApiController]
[Route("api/[controller]")]
public class CastController : ControllerBase
{
    private readonly MediaCommandService _media;

    public CastController(IMediaCommandService media)
    {
        _media = (MediaCommandService)media;
    }

    [HttpPost]
    public async Task<ActionResult<ApiResponse>> Cast([FromBody] CastRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Url))
            return BadRequest(ApiResponse.Fail("URL is required"));

        try
        {
            await _media.CastUrlAsync(request.Url, request.DeviceId);
            return Ok(ApiResponse.Ok(message: "Video sent to SmartTube"));
        }
        catch (Exception ex)
        {
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }

    [HttpPost("search")]
    public async Task<ActionResult<ApiResponse>> Search([FromBody] SearchRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Query))
            return BadRequest(ApiResponse.Fail("Search query is required"));

        try
        {
            await _media.SearchAsync(request.Query, request.DeviceId);
            return Ok(ApiResponse.Ok(message: "Search sent to SmartTube"));
        }
        catch (Exception ex)
        {
            return StatusCode(500, ApiResponse.Fail(ex.Message));
        }
    }
}
