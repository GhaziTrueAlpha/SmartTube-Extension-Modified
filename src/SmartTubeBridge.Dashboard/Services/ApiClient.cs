using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Dashboard.Services;

public class ApiClient
{
    private readonly HttpClient _http;
    private readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    public ApiClient(string baseUrl = "http://localhost:8765")
    {
        _http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(10) };
    }

    public async Task<ServiceStatus?> GetStatusAsync()
    {
        var resp = await _http.GetAsync("api/status");
        resp.EnsureSuccessStatusCode();
        var doc = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return doc.TryGetProperty("data", out var data)
            ? JsonSerializer.Deserialize<ServiceStatus>(data.GetRawText(), _json)
            : null;
    }

    public async Task<List<DeviceInfo>> GetDeviceListAsync()
    {
        var resp = await _http.GetAsync("api/device");
        resp.EnsureSuccessStatusCode();
        var doc = await resp.Content.ReadFromJsonAsync<JsonElement>();
        if (doc.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            return JsonSerializer.Deserialize<List<DeviceInfo>>(data.GetRawText(), _json) ?? new();
        }
        return new();
    }

    public async Task<List<DeviceInfo>> ScanDevicesAsync()
    {
        var resp = await _http.PostAsync("api/device/scan", null);
        resp.EnsureSuccessStatusCode();
        var doc = await resp.Content.ReadFromJsonAsync<JsonElement>();
        if (doc.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            return JsonSerializer.Deserialize<List<DeviceInfo>>(data.GetRawText(), _json) ?? new();
        }
        return new();
    }

    public async Task<bool> ConnectDeviceAsync(string ip, int port = 5555)
    {
        var resp = await _http.PostAsJsonAsync("api/device/connect", new { ip, port });
        return resp.IsSuccessStatusCode;
    }

    public async Task<bool> ConnectSerialAsync(string serial)
    {
        var resp = await _http.PostAsJsonAsync("api/device/connect", new { serial });
        return resp.IsSuccessStatusCode;
    }

    public async Task<bool> DisconnectAsync(string serial)
    {
        var resp = await _http.PostAsJsonAsync("api/device/disconnect", new { serial });
        return resp.IsSuccessStatusCode;
    }

    public async Task<ApiResponse> CastAsync(string url)
    {
        var resp = await _http.PostAsJsonAsync("api/cast", new { url });
        var result = await resp.Content.ReadFromJsonAsync<ApiResponse>();
        return result ?? ApiResponse.Fail("No response");
    }

    public async Task<ApiResponse> SendMediaAsync(string endpoint)
    {
        var resp = await _http.PostAsync($"api/media/{endpoint}", null);
        var result = await resp.Content.ReadFromJsonAsync<ApiResponse>();
        return result ?? ApiResponse.Fail("No response");
    }

    public async Task<ApiResponse> SetVolumeAsync(int level)
    {
        var resp = await _http.PostAsJsonAsync("api/media/volume", new { level });
        var result = await resp.Content.ReadFromJsonAsync<ApiResponse>();
        return result ?? ApiResponse.Fail("No response");
    }

    public async Task<AppConfig?> GetSettingsAsync()
    {
        var resp = await _http.GetAsync("api/settings");
        resp.EnsureSuccessStatusCode();
        var doc = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return doc.TryGetProperty("data", out var data)
            ? JsonSerializer.Deserialize<AppConfig>(data.GetRawText(), _json)
            : null;
    }

    public async Task<bool> UpdateSettingsAsync(AppConfig config)
    {
        var resp = await _http.PostAsJsonAsync("api/settings", config);
        return resp.IsSuccessStatusCode;
    }

    public async Task<List<LogEntry>> GetLogsAsync(int max = 100)
    {
        var resp = await _http.GetAsync($"api/logs?max={max}");
        resp.EnsureSuccessStatusCode();
        var doc = await resp.Content.ReadFromJsonAsync<JsonElement>();
        if (doc.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            return JsonSerializer.Deserialize<List<LogEntry>>(data.GetRawText(), _json) ?? new();
        }
        return new();
    }
}
