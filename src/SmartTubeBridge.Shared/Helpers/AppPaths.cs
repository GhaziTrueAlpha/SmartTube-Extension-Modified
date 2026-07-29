namespace SmartTubeBridge.Shared.Helpers;

/// <summary>
/// Shared data directory used by both the LocalSystem Windows Service and interactive apps.
/// Using ProgramData avoids split configs between user AppData and the system profile.
/// </summary>
public static class AppPaths
{
    public static string DataDirectory { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SmartTubeBridge");

    public static string ConfigPath => Path.Combine(DataDirectory, "config.json");
    public static string LogsDirectory => Path.Combine(DataDirectory, "logs");

    public static void EnsureInitialized()
    {
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(LogsDirectory);
        MigrateLegacyConfigIfNeeded();
    }

    private static void MigrateLegacyConfigIfNeeded()
    {
        var currentCount = File.Exists(ConfigPath) ? CountSavedDevices(File.ReadAllText(ConfigPath)) : 0;

        // If ProgramData already has saved devices, leave it alone.
        if (currentCount > 0)
            return;

        string? bestPath = null;
        var bestDeviceCount = 0;

        foreach (var candidate in GetLegacyConfigCandidates())
        {
            try
            {
                if (!File.Exists(candidate) ||
                    string.Equals(candidate, ConfigPath, StringComparison.OrdinalIgnoreCase))
                    continue;

                var count = CountSavedDevices(File.ReadAllText(candidate));
                if (count > bestDeviceCount)
                {
                    bestDeviceCount = count;
                    bestPath = candidate;
                }
            }
            catch
            {
                // try next
            }
        }

        if (bestPath == null || bestDeviceCount == 0)
            return;

        try
        {
            File.Copy(bestPath, ConfigPath, overwrite: true);
        }
        catch
        {
            // leave existing ProgramData config as-is
        }
    }

    private static int CountSavedDevices(string json)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (prop.NameEquals("SavedDevices") || prop.NameEquals("savedDevices"))
                {
                    if (prop.Value.ValueKind == System.Text.Json.JsonValueKind.Array)
                        return prop.Value.GetArrayLength();
                }
            }
        }
        catch { }
        return 0;
    }

    private static IEnumerable<string> GetLegacyConfigCandidates()
    {
        var usersRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "..", "Users");
        usersRoot = Path.GetFullPath(usersRoot);
        if (Directory.Exists(usersRoot))
        {
            foreach (var userDir in Directory.EnumerateDirectories(usersRoot))
            {
                var name = Path.GetFileName(userDir);
                if (name is "Public" or "Default" or "Default User" or "All Users")
                    continue;

                yield return Path.Combine(userDir, "AppData", "Roaming", "SmartTubeBridge", "config.json");
            }
        }

        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "SmartTubeBridge", "config.json");

        var systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var windows = Directory.GetParent(systemRoot)?.FullName;
        if (!string.IsNullOrEmpty(windows))
        {
            yield return Path.Combine(
                windows, "System32", "config", "systemprofile",
                "AppData", "Roaming", "SmartTubeBridge", "config.json");
        }
    }
}
