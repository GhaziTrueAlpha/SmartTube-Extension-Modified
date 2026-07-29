using FluentAssertions;
using SmartTubeBridge.Shared.Constants;
using Xunit;

namespace SmartTubeBridge.Shared.Tests;

public class KeyCodesTests
{
    [Fact]
    public void KeyCodes_ShouldHaveRequiredValues()
    {
        KeyCodes.WakeUp.Should().Be(224);
        KeyCodes.MediaPlayPause.Should().Be(85);
        KeyCodes.Home.Should().Be(3);
        KeyCodes.Back.Should().Be(4);
        KeyCodes.VolumeUp.Should().Be(24);
        KeyCodes.VolumeDown.Should().Be(25);
    }

    [Fact]
    public void AllKeyCodes_ShouldHaveDescriptions()
    {
        var codes = new[]
        {
            KeyCodes.WakeUp, KeyCodes.Sleep, KeyCodes.Power,
            KeyCodes.MediaPlayPause, KeyCodes.MediaStop,
            KeyCodes.MediaNext, KeyCodes.MediaPrevious,
            KeyCodes.MediaRewind, KeyCodes.MediaFastForward,
            KeyCodes.MediaPlay, KeyCodes.MediaPause,
            KeyCodes.VolumeUp, KeyCodes.VolumeDown, KeyCodes.Mute,
            KeyCodes.Home, KeyCodes.Back, KeyCodes.Menu,
            KeyCodes.Search, KeyCodes.Settings
        };

        foreach (var code in codes)
            KeyCodes.Descriptions.Should().ContainKey(code);
    }
}
