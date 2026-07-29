using System.Text.RegularExpressions;

namespace SmartTubeBridge.Shared.Helpers;

public static partial class YouTubeUrlHelper
{
    [GeneratedRegex(@"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/|youtube\.com/live/)([a-zA-Z0-9_-]{11})", RegexOptions.IgnoreCase)]
    private static partial Regex VideoIdPattern();

    public static string? ExtractVideoId(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;

        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var host = uri.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase);

            if (host.Equals("youtu.be", StringComparison.OrdinalIgnoreCase))
            {
                var id = uri.AbsolutePath.TrimStart('/').Split('/')[0];
                return id.Length == 11 ? id : null;
            }

            if (host.Contains("youtube.com", StringComparison.OrdinalIgnoreCase))
            {
                var v = GetQueryParam(uri.Query, "v");
                if (!string.IsNullOrEmpty(v) && v.Length == 11) return v;

                var pathMatch = Regex.Match(uri.AbsolutePath, @"/(shorts|embed|live|v)/([a-zA-Z0-9_-]{11})", RegexOptions.IgnoreCase);
                if (pathMatch.Success) return pathMatch.Groups[2].Value;
            }
        }

        var match = VideoIdPattern().Match(url);
        return match.Success ? match.Groups[1].Value : null;
    }

    public static string Normalize(string url)
    {
        var videoId = ExtractVideoId(url);
        if (videoId == null) return url;

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return $"https://www.youtube.com/watch?v={videoId}";

        var list = GetQueryParam(uri.Query, "list");
        var t = GetQueryParam(uri.Query, "t") ?? GetQueryParam(uri.Query, "start");

        var normalized = new System.Text.StringBuilder($"https://www.youtube.com/watch?v={videoId}");
        if (!string.IsNullOrEmpty(list))
            normalized.Append("&list=").Append(Uri.EscapeDataString(list));
        if (!string.IsNullOrEmpty(t))
            normalized.Append("&t=").Append(Uri.EscapeDataString(t));

        return normalized.ToString();
    }

    public static bool IsYouTubeUrl(string url) =>
        !string.IsNullOrWhiteSpace(url) &&
        (url.Contains("youtube.com", StringComparison.OrdinalIgnoreCase) ||
         url.Contains("youtu.be", StringComparison.OrdinalIgnoreCase));

    private static string? GetQueryParam(string query, string key)
    {
        if (string.IsNullOrEmpty(query)) return null;
        var q = query.TrimStart('?');
        foreach (var part in q.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && kv[0].Equals(key, StringComparison.OrdinalIgnoreCase))
                return Uri.UnescapeDataString(kv[1]);
        }
        return null;
    }
}
