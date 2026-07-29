namespace SmartTubeBridge.Shared.Helpers;

public static class AdbPathHelper
{
    public static readonly string[] DefaultSdkPaths = BuildSdkPaths();

    private static string[] BuildSdkPaths()
    {
        var paths = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Android", "Sdk", "platform-tools", "adb.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Android", "android-sdk", "platform-tools", "adb.exe"),
            @"C:\Android\platform-tools\adb.exe",
            @"C:\Android\sdk\platform-tools\adb.exe",
            @"C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe",
        };

        // WinGet paths — check both current user and all user profiles
        paths.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WinGet", "Packages", "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe",
            "platform-tools", "adb.exe"));

        // When running as SYSTEM (Windows Service), also probe real user profiles
        AddUserWinGetPaths(paths);

        return paths.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static void AddUserWinGetPaths(List<string> paths)
    {
        try
        {
            var usersDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "..", "Users");
            if (!Directory.Exists(usersDir)) return;

            foreach (var userDir in Directory.GetDirectories(usersDir))
            {
                var name = Path.GetFileName(userDir);
                if (name.StartsWith(".") || name == "Public" || name == "Default" || name == "All Users")
                    continue;

                // Android SDK platform-tools from Android Studio
                var sdkPath = Path.Combine(userDir, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe");
                if (File.Exists(sdkPath)) paths.Add(sdkPath);

                // WinGet install of Google Platform Tools
                var wingetPath = Path.Combine(userDir, "AppData", "Local",
                    "Microsoft", "WinGet", "Packages",
                    "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe",
                    "platform-tools", "adb.exe");
                if (File.Exists(wingetPath)) paths.Add(wingetPath);
            }
        }
        catch { /* best effort */ }
    }

    public static bool IsDefaultPath(string? path) =>
        string.IsNullOrWhiteSpace(path) ||
        path.Equals("adb", StringComparison.OrdinalIgnoreCase);

    public static bool IsValidPath(string path) =>
        path.Equals("adb", StringComparison.OrdinalIgnoreCase) ||
        File.Exists(path) ||
        File.Exists(path + ".exe");

    public static string? FindOnPath(string exe = "adb.exe")
    {
        var paths = Environment.GetEnvironmentVariable("PATH")?.Split(Path.PathSeparator) ?? [];
        foreach (var dir in paths)
        {
            var full = Path.Combine(dir.Trim(), exe);
            if (File.Exists(full)) return full;
        }
        return null;
    }

    public static List<AdbCandidate> DiscoverCandidates()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var results = new List<AdbCandidate>();

        void Add(string path, string source)
        {
            if (string.IsNullOrWhiteSpace(path) || !seen.Add(path)) return;
            if (!IsValidPath(path)) return;
            results.Add(new AdbCandidate { Path = path, Source = source });
        }

        Add("adb", "System PATH (adb)");
        var fromPath = FindOnPath();
        if (fromPath != null) Add(fromPath, "PATH search");

        foreach (var p in DefaultSdkPaths)
            if (File.Exists(p)) Add(p, "Android SDK");

        return results;
    }
}

public class AdbCandidate
{
    public string Path { get; set; } = string.Empty;
    public string Source { get; set; } = string.Empty;
}
