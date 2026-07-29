namespace SmartTubeBridge.Shared.Constants;

public static class ApiRoutes
{
    private const string Base = "/api";

    public static class Cast
    {
        public const string Play = Base + "/cast";
        public const string Search = Base + "/cast/search";
    }

    public static class Media
    {
        private const string Prefix = Base + "/media";
        public const string Play = Prefix + "/play";
        public const string Pause = Prefix + "/pause";
        public const string PlayPause = Prefix + "/playpause";
        public const string Next = Prefix + "/next";
        public const string Previous = Prefix + "/previous";
        public const string FastForward = Prefix + "/forward";
        public const string Rewind = Prefix + "/rewind";
        public const string Stop = Prefix + "/stop";
        public const string VolumeUp = Prefix + "/volume/up";
        public const string VolumeDown = Prefix + "/volume/down";
        public const string Mute = Prefix + "/volume/mute";
        public const string Home = Prefix + "/home";
        public const string Back = Prefix + "/back";
    }

    public static class Device
    {
        private const string Prefix = Base + "/devices";
        public const string List = Prefix;
        public const string Scan = Prefix + "/scan";
        public const string Connect = Prefix + "/connect";
        public const string Disconnect = Prefix + "/disconnect";
        public const string Forget = Prefix + "/{id}";
    }

    public static class Status
    {
        public const string Get = Base + "/status";
        public const string Ping = Base + "/ping";
    }

    public static class Logs
    {
        public const string Get = Base + "/logs";
        public const string Clear = Base + "/logs/clear";
    }

    public static class Settings
    {
        public const string Get = Base + "/settings";
        public const string Update = Base + "/settings";
    }
}
