using System.Windows;
using System.Windows.Controls;
using SmartTubeBridge.Dashboard.Services;
using SmartTubeBridge.Shared.Models;

namespace SmartTubeBridge.Dashboard;

public partial class MainWindow : Window
{
    private readonly ApiClient _api = new();
    private readonly CancellationTokenSource _cts = new();
    private ServiceStatus? _lastStatus;
    private List<DeviceInfo> _devices = new();

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        _ = PollLoopAsync(_cts.Token);
    }

    private async Task PollLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _lastStatus = await _api.GetStatusAsync();
                _devices = await _api.GetDeviceListAsync();

                var cfg = await _api.GetSettingsAsync();
                if (cfg != null)
                {
                    Dispatcher.Invoke(() =>
                    {
                        AdbPathInput.Text = cfg.AdbPath;
                        PackageInput.Text = cfg.PackageName;
                        WizardAdbPath.Text = cfg.AdbPath;
                    });
                }

                Dispatcher.Invoke(UpdateUi);
            }
            catch
            {
                Dispatcher.Invoke(() =>
                {
                    StatusText.Text = "Service Offline";
                    StatusBadge.Background = System.Windows.Media.Brushes.DarkRed;
                    FooterText.Text = "Cannot connect to SmartTube Bridge Service on port 8765";
                });
            }

            await Task.Delay(3000, ct);
        }
    }

    private void UpdateUi()
    {
        if (_lastStatus == null) return;

        var connected = _lastStatus.IsConnected;

        StatusText.Text = connected ? "Connected" : "Disconnected";
        StatusBadge.Background = connected
            ? System.Windows.Media.Brushes.DarkGreen
            : System.Windows.Media.Brushes.DarkOrange;

        AdbStatusText.Text = _lastStatus.AdbState.ToString();
        DeviceText.Text = _lastStatus.CurrentDevice?.FriendlyName ?? "None";
        PackageText.Text = _lastStatus.PackageName;

        DeviceList.Items.Clear();
        foreach (var d in _devices)
        {
            DeviceList.Items.Add($"{d.FriendlyName,-20} {d.State,-15} {(d.Transport == "tcpip" ? d.IpAddress : "USB")}");
        }

        FooterText.Text = connected
            ? $"Connected to {_lastStatus.CurrentDevice?.FriendlyName} via ADB"
            : "No device connected";
    }

    private async void ScanDevices_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            FooterText.Text = "Scanning...";
            _devices = await _api.ScanDevicesAsync();
            UpdateUi();
            FooterText.Text = $"Found {_devices.Count} device(s)";
        }
        catch (Exception ex)
        {
            FooterText.Text = $"Scan failed: {ex.Message}";
        }
    }

    private void ManualIpInput_TextChanged(object sender, TextChangedEventArgs e)
    {
        ConnectBtn.IsEnabled = !string.IsNullOrWhiteSpace(ManualIpInput.Text);
    }

    private void WizardIpInput_TextChanged(object sender, TextChangedEventArgs e)
    {
        WizardConnectBtn.IsEnabled = !string.IsNullOrWhiteSpace(WizardIpInput.Text);
    }

    private async void ConnectManual_Click(object sender, RoutedEventArgs e)
    {
        var ip = ManualIpInput.Text.Trim();
        if (string.IsNullOrEmpty(ip)) ip = WizardIpInput.Text.Trim();
        if (string.IsNullOrEmpty(ip)) return;

        try
        {
            FooterText.Text = $"Connecting to {ip}...";
            var ok = await _api.ConnectDeviceAsync(ip);
            if (ok)
            {
                FooterText.Text = $"Connected to {ip}";
                await Task.Delay(1000);
                await PollLoopAsync(_cts.Token);
            }
            else
            {
                FooterText.Text = $"Failed to connect to {ip}";
            }
        }
        catch (Exception ex)
        {
            FooterText.Text = $"Error: {ex.Message}";
        }
    }

    private async void Disconnect_Click(object sender, RoutedEventArgs e)
    {
        var device = _lastStatus?.CurrentDevice;
        if (device == null) return;

        try
        {
            await _api.DisconnectAsync(device.Serial);
            FooterText.Text = "Disconnected";
        }
        catch (Exception ex)
        {
            FooterText.Text = $"Error: {ex.Message}";
        }
    }

    private async void Media_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.Tag is string endpoint)
        {
            try
            {
                await _api.SendMediaAsync(endpoint);
                FooterText.Text = $"Sent: {endpoint}";
            }
            catch (Exception ex)
            {
                FooterText.Text = $"Error: {ex.Message}";
            }
        }
    }

    private CancellationTokenSource? _volumeCts;

    private async void VolumeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (!IsLoaded) return;
        var level = (int)Math.Round(e.NewValue);
        VolumeLabel.Text = level.ToString();

        _volumeCts?.Cancel();
        _volumeCts = new CancellationTokenSource();
        var token = _volumeCts.Token;
        try
        {
            await Task.Delay(250, token);
            await _api.SetVolumeAsync(level);
            FooterText.Text = $"Volume set to {level}";
        }
        catch (TaskCanceledException) { }
        catch (Exception ex)
        {
            FooterText.Text = $"Volume error: {ex.Message}";
        }
    }

    private async void SaveSettings_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var cfg = new AppConfig
            {
                AdbPath = AdbPathInput.Text,
                PackageName = PackageInput.Text,
                WakeDelayMs = int.Parse((WakeDelayInput.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "500")
            };
            await _api.UpdateSettingsAsync(cfg);
            FooterText.Text = "Settings saved";
        }
        catch (Exception ex)
        {
            FooterText.Text = $"Error: {ex.Message}";
        }
    }

    private async void RefreshLogs_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var logs = await _api.GetLogsAsync(100);
            LogList.Items.Clear();
            foreach (var log in logs)
            {
                LogList.Items.Add($"[{log.Timestamp:HH:mm:ss}] [{log.Level,-7}] [{log.Source}] {log.Message}");
            }
            FooterText.Text = $"Loaded {logs.Count} log entries";
        }
        catch (Exception ex)
        {
            FooterText.Text = $"Error: {ex.Message}";
        }
    }

    private void BrowseAdb_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "ADB Executable|adb.exe|Executable Files|*.exe|All Files|*.*",
            Title = "Locate adb.exe"
        };
        if (dlg.ShowDialog() == true)
        {
            WizardAdbPath.Text = dlg.FileName;
        }
    }

    private async void TestConnection_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var status = await _api.GetStatusAsync();
            if (status?.IsConnected == true)
            {
                MessageBox.Show($"Connected to {status.CurrentDevice?.FriendlyName}\nADB: {status.AdbState}",
                    "Connection Test", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                MessageBox.Show("Service is running but no device connected.\nScan or connect a device.",
                    "Connection Test", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Cannot reach service: {ex.Message}",
                "Connection Test", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        _cts.Cancel();
        base.OnClosed(e);
    }
}
