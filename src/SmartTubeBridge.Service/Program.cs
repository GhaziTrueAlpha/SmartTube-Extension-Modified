using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Extensions.Hosting.WindowsServices;
using SmartTubeBridge.Service;
using SmartTubeBridge.Service.Middleware;
using SmartTubeBridge.Service.Services;
using SmartTubeBridge.Shared.Helpers;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;

const string MutexName = @"Global\SmartTubeBridgeService.SingleInstance";
var isWindowsService = WindowsServiceHelpers.IsWindowsService();

AppPaths.EnsureInitialized();

using var mutex = new Mutex(initiallyOwned: true, name: MutexName, createdNew: out var createdNew);
if (!createdNew)
{
    ExitEarly(
        "SmartTube Bridge is already running.",
        "Open http://127.0.0.1:8765/  (do not start a second copy)");
    return;
}

var apiPort = 8765;
if (File.Exists(AppPaths.ConfigPath))
{
    try
    {
        var json = await File.ReadAllTextAsync(AppPaths.ConfigPath);
        var cfg = JsonSerializer.Deserialize<AppConfig>(json);
        if (cfg?.ApiPort > 0) apiPort = cfg.ApiPort;
    }
    catch { /* use default port */ }
}

var cliPortIndex = Array.IndexOf(args, "--port");
if (cliPortIndex >= 0 && cliPortIndex + 1 < args.Length && int.TryParse(args[cliPortIndex + 1], out var cliPort))
    apiPort = cliPort;

if (!IsPortAvailable(apiPort))
{
    ExitEarly(
        $"Port {apiPort} is already in use.",
        "Stop the other SmartTubeBridge.Service process (or whatever is using that port), then retry.",
        $"Only run: {Path.Combine(AppContext.BaseDirectory, "SmartTubeBridge.Service.exe")}");
    return;
}

// Always use the exe folder as content root so Windows Service (CWD=System32) still finds wwwroot/appsettings.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
    ApplicationName = typeof(Program).Assembly.GetName().Name
});

builder.WebHost.UseUrls($"http://127.0.0.1:{apiPort}");

builder.Host.UseWindowsService(options =>
{
    // Must match the SCM service name from install-service.ps1 (not the display name).
    options.ServiceName = "SmartTubeBridgeService";
});

builder.Services.AddSingleton<IConfigService, ConfigService>();
builder.Services.AddSingleton<ILogService, LogService>();
builder.Services.AddSingleton<IAdbService, AdbService>();
builder.Services.AddSingleton<IDeviceManager, DeviceManager>();
builder.Services.AddSingleton<IMediaCommandService, MediaCommandService>();
builder.Services.AddHostedService<SmartTubeWorker>();

builder.Services.AddControllers();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

var app = builder.Build();

app.UseMiddleware<ExceptionHandlingMiddleware>();
app.UseMiddleware<RequestValidationMiddleware>();
app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapControllers();

app.MapGet("/health", () => Results.Ok(new { status = "ok", service = "SmartTube Bridge" }));

var log = app.Services.GetRequiredService<ILogService>();
log.Info("Service", $"SmartTube Bridge Service starting on http://127.0.0.1:{apiPort}");
log.Info("Service", $"Data directory: {AppPaths.DataDirectory}");

try
{
    app.Run();
}
catch (Exception ex)
{
    log.Error("Service", "Fatal error on startup", ex);
    if (!isWindowsService && Environment.UserInteractive)
    {
        Console.Error.WriteLine(ex);
        Console.WriteLine("Press Enter to close...");
        try { Console.ReadLine(); } catch { }
    }
    throw;
}

static bool IsPortAvailable(int port)
{
    try
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        listener.Stop();
        return true;
    }
    catch (SocketException)
    {
        return false;
    }
}

static void ExitEarly(params string[] messages)
{
    foreach (var message in messages)
        Console.Error.WriteLine(message);

    // Interactive double-clicks otherwise flash a blank console and close instantly.
    if (!WindowsServiceHelpers.IsWindowsService() && Environment.UserInteractive)
    {
        Console.WriteLine();
        Console.WriteLine("Press Enter to close...");
        try { Console.ReadLine(); } catch { }
    }

    Environment.ExitCode = 1;
}
