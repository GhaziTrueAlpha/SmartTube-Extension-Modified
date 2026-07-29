namespace SmartTubeBridge.Shared.Constants;

public static class KeyCodes
{
    public const int WakeUp = 224;
    public const int Sleep = 223;
    public const int Power = 26;

    public const int MediaPlayPause = 85;
    public const int MediaStop = 86;
    public const int MediaNext = 87;
    public const int MediaPrevious = 88;
    public const int MediaRewind = 89;
    public const int MediaFastForward = 90;
    public const int MediaPlay = 126;
    public const int MediaPause = 127;

    public const int VolumeUp = 24;
    public const int VolumeDown = 25;
    public const int Mute = 91;

    public const int DpadUp = 19;
    public const int DpadDown = 20;
    public const int DpadLeft = 21;
    public const int DpadRight = 22;
    public const int DpadCenter = 23;

    public const int Home = 3;
    public const int Back = 4;
    public const int Menu = 82;
    public const int Search = 84;
    public const int Settings = 176;

    public static Dictionary<int, string> Descriptions { get; } = new()
    {
        { WakeUp, "Wake Up" },
        { Sleep, "Sleep" },
        { Power, "Power" },
        { MediaPlayPause, "Play/Pause" },
        { MediaStop, "Stop" },
        { MediaNext, "Next Track" },
        { MediaPrevious, "Previous Track" },
        { MediaRewind, "Rewind" },
        { MediaFastForward, "Fast Forward" },
        { MediaPlay, "Play" },
        { MediaPause, "Pause" },
        { VolumeUp, "Volume Up" },
        { VolumeDown, "Volume Down" },
        { Mute, "Mute" },
        { Home, "Home" },
        { Back, "Back" },
        { Menu, "Menu" },
        { Search, "Search" },
        { Settings, "Settings" },
    };
}
