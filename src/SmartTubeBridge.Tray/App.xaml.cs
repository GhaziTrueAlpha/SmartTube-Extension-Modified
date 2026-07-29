using System.Windows;

namespace SmartTubeBridge.Tray;

public partial class App : System.Windows.Application
{
    private TrayApplication? _tray;

    private void ApplicationStartup(object sender, StartupEventArgs e)
    {
        _tray = new TrayApplication();
        _tray.Initialize();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _tray?.Dispose();
        base.OnExit(e);
    }
}
