using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Forms;
using SmartTubeBridge.Shared.Models;
using Application = System.Windows.Application;

namespace SmartTubeBridge.Tray;

public class TrayApplication : IDisposable
{
    private NotifyIcon? _trayIcon;
    private ContextMenuStrip? _menu;
    private readonly HttpClient _http = new() { BaseAddress = new Uri("http://localhost:8765") };
    private readonly PeriodicTimer _timer = new(TimeSpan.FromSeconds(5));
    private ServiceStatus? _lastStatus;
    private CancellationTokenSource? _cts;

    public void Initialize()
    {
        _cts = new CancellationTokenSource();
        BuildMenu();
        BuildIcon();
        _ = PollStatusAsync(_cts.Token);
    }

    private void BuildIcon()
    {
        _trayIcon = new NotifyIcon
        {
            Icon = CreateDefaultIcon(),
            Text = "SmartTube Bridge",
            Visible = true,
            ContextMenuStrip = _menu
        };
        _trayIcon.DoubleClick += (_, _) => OpenDashboard();
    }

    private void BuildMenu()
    {
        _menu = new ContextMenuStrip();
        _menu.Items.Add("Dashboard", null, (_, _) => OpenDashboard());
        _menu.Items.Add("Reconnect TV", null, async (_, _) => await ReconnectAsync());
        _menu.Items.Add("Settings", null, (_, _) => OpenSettings());
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add("Restart Service", null, async (_, _) => await RestartServiceAsync());
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add("Exit", null, (_, _) => Exit());
    }

    private async Task PollStatusAsync(CancellationToken ct)
    {
        try
        {
            while (await _timer.WaitForNextTickAsync(ct))
            {
                try
                {
                    var resp = await _http.GetAsync("api/status", ct);
                    if (resp.IsSuccessStatusCode)
                    {
                        var json = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
                        if (json.TryGetProperty("data", out var data))
                        {
                            _lastStatus = JsonSerializer.Deserialize<ServiceStatus>(
                                data.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        }
                    }
                    UpdateIcon();
                }
                catch
                {
                    _lastStatus = null;
                    UpdateIcon();
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private void UpdateIcon()
    {
        if (_trayIcon == null) return;

        var connected = _lastStatus?.IsConnected ?? false;
        _trayIcon.Text = connected
            ? $"SmartTube Bridge\nConnected: {_lastStatus?.CurrentDevice?.FriendlyName ?? "Unknown"}"
            : "SmartTube Bridge\nDisconnected";

        var deviceName = _lastStatus?.CurrentDevice?.FriendlyName ?? "";
        _trayIcon.BalloonTipTitle = connected ? "Connected" : "Disconnected";
        _trayIcon.BalloonTipText = connected
            ? $"Device: {deviceName}"
            : "No device connected";
    }

    private void OpenDashboard()
    {
        var path = System.IO.Path.Combine(
            AppDomain.CurrentDomain.BaseDirectory,
            "SmartTubeBridge.Dashboard.exe");
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch
        {
            Process.Start(new ProcessStartInfo("http://localhost:8765") { UseShellExecute = true });
        }
    }

    private void OpenSettings()
    {
        OpenDashboard();
    }

    private async Task ReconnectAsync()
    {
        try
        {
            await _http.PostAsync("api/device/scan", null);
            _trayIcon?.ShowBalloonTip(2000, "SmartTube Bridge", "Reconnection triggered", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            _trayIcon?.ShowBalloonTip(2000, "Error", ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task RestartServiceAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await _http.PostAsync("api/service/restart", null, cts.Token);
        }
        catch
        {
            System.Windows.Forms.MessageBox.Show("Cannot restart the service from here.\nUse services.msc or reboot.", "SmartTube Bridge",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private void Exit()
    {
        _cts?.Cancel();
        if (_trayIcon != null)
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _trayIcon = null;
        }
        Application.Current.Shutdown();
    }

    private static Icon CreateDefaultIcon()
    {
        using var bmp = new Bitmap(16, 16);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.Transparent);
        g.FillRectangle(Brushes.DodgerBlue, 2, 2, 12, 12);
        g.DrawString("S", new System.Drawing.Font("Segoe UI", 8, System.Drawing.FontStyle.Bold), Brushes.White, 3, 3);
        return Icon.FromHandle(bmp.GetHicon());
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _timer?.Dispose();
        _trayIcon?.Dispose();
        _http?.Dispose();
    }
}
