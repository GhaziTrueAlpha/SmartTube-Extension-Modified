using System.Windows;
using System.Windows.Threading;

namespace SmartTubeBridge.Dashboard;

public partial class App : Application
{
    public App()
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnAppDomainException;
        TaskScheduler.UnobservedTaskException += OnTaskException;
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        MessageBox.Show(
            $"Unhandled UI exception:\n{e.Exception.Message}\n\n{e.Exception.StackTrace}",
            "SmartTube Bridge - Error",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        e.Handled = true;
    }

    private void OnAppDomainException(object sender, UnhandledExceptionEventArgs e)
    {
        var ex = e.ExceptionObject as Exception;
        MessageBox.Show(
            $"Unhandled application exception:\n{ex?.Message}",
            "SmartTube Bridge - Fatal Error",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
    }

    private void OnTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        MessageBox.Show(
            $"Unhandled task exception:\n{e.Exception?.InnerException?.Message}",
            "SmartTube Bridge - Error",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        e.SetObserved();
    }
}
