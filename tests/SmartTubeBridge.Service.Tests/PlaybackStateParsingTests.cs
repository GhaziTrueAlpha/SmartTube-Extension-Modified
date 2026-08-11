using FluentAssertions;
using SmartTubeBridge.Service.Services;
using Xunit;

namespace SmartTubeBridge.Service.Tests;

/// <summary>
/// Fixtures below are verbatim captures from a real Acer R4_GTV running
/// SmartTube org.smarttube.stable (2026-08-10), not synthetic samples.
/// </summary>
public class PlaybackStateParsingTests
{
    private const string PlayingLine =
        "      state=PlaybackState {state=PLAYING(3), position=10021, buffered position=15680, " +
        "speed=1.0, updated=312846862, actions=2360191, custom actions=[], active item id=0, error=null}";

    private const string PausedLine =
        "      state=PlaybackState {state=PAUSED(2), position=42695, buffered position=49200, " +
        "speed=0.0, updated=313051714, actions=2360191, custom actions=[], active item id=0, error=null}";

    [Fact]
    public void Extrapolates_stale_playing_position_to_now()
    {
        // Device clock at read time, captured alongside the dump above.
        const long deviceNowMs = 312_929_450;

        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs);

        result.Should().NotBeNull();
        result!.RawPositionMs.Should().Be(10_021);
        result.StalenessMs.Should().Be(82_588, "snapshot was 82.6s old — this is the sync bug");
        result.Speed.Should().Be(1.0);
        result.PositionMs.Should().Be(92_609, "10021 + 82588 * 1.0");
        result.IsPlaying.Should().BeTrue();
    }

    [Fact]
    public void Does_not_advance_position_while_paused()
    {
        const long deviceNowMs = 313_063_830;

        var result = AdbService.ParsePlaybackState(PausedLine, deviceNowMs);

        result.Should().NotBeNull();
        result!.Speed.Should().Be(0.0);
        result.PositionMs.Should().Be(42_695, "speed=0 means the snapshot is still current");
        result.RawPositionMs.Should().Be(42_695);
        result.IsPlaying.Should().BeFalse();
    }

    [Fact]
    public void Ignores_buffered_position_when_reading_position()
    {
        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs: 0);

        result.Should().NotBeNull();
        result!.RawPositionMs.Should().Be(10_021, "must not pick up 'buffered position=15680'");
    }

    [Fact]
    public void Falls_back_to_raw_position_when_device_clock_unknown()
    {
        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs: 0);

        result.Should().NotBeNull();
        result!.StalenessMs.Should().Be(0);
        result.PositionMs.Should().Be(10_021, "no extrapolation is better than a wrong one");
    }

    [Fact]
    public void Never_extrapolates_backwards_on_clock_skew()
    {
        // deviceNow earlier than updated — treat as unknown rather than negative staleness.
        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs: 312_000_000);

        result.Should().NotBeNull();
        result!.StalenessMs.Should().Be(0);
        result.PositionMs.Should().Be(10_021);
    }

    [Fact]
    public void Refuses_to_extrapolate_an_idle_stale_session()
    {
        // Observed live: SmartTube sat idle keeping speed=1.0 on an 82-minute-old snapshot.
        // Extrapolating that yielded a 4 911 528 ms position out of a raw position of 0.
        const string idleLine =
            "      state=PlaybackState {state=NONE(0), position=0, buffered position=0, " +
            "speed=1.0, updated=1000, actions=2360191, custom actions=[], active item id=0, error=null}";

        var result = AdbService.ParsePlaybackState(idleLine, deviceNowMs: 4_912_528);

        result.Should().NotBeNull();
        result!.StalenessMs.Should().Be(4_911_528);
        result.PositionMs.Should().Be(0, "an hours-old snapshot must not be advanced");
        result.IsPlaying.Should().BeFalse();
    }

    [Fact]
    public void Does_not_extrapolate_past_the_absurdity_bound()
    {
        // Playing, but the snapshot claims to be 20 minutes old — longer than any track.
        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs: 312_846_862 + 1_200_000);

        result.Should().NotBeNull();
        result!.StalenessMs.Should().Be(1_200_000);
        result.PositionMs.Should().Be(10_021, "fall back to raw rather than invent a position");
    }

    [Fact]
    public void Extrapolates_long_but_plausible_gaps_on_a_playing_session()
    {
        // SmartTube pushes state updates rarely; 82s stale while PLAYING is real and correct.
        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs: 312_929_450);

        result.Should().NotBeNull();
        result!.PositionMs.Should().Be(92_609);
    }

    [Fact]
    public void Still_extrapolates_within_the_sanity_window()
    {
        var result = AdbService.ParsePlaybackState(PlayingLine, deviceNowMs: 312_846_862 + 2_500);

        result.Should().NotBeNull();
        result!.PositionMs.Should().Be(12_521, "10021 + 2500 * 1.0");
    }

    [Fact]
    public void Parses_uptime_first_field_as_milliseconds()
    {
        var lines = new[] { "312929.45 1201840.48", "Sessions Stack - have 3 sessions:" };

        AdbService.ParseUptimeMs(lines).Should().Be(312_929_450);
    }

    [Fact]
    public void Returns_zero_uptime_when_absent()
    {
        AdbService.ParseUptimeMs(new[] { "Sessions Stack - have 3 sessions:" }).Should().Be(0);
    }

    [Fact]
    public void Extracts_title_and_artist_from_metadata()
    {
        var lines = new[]
        {
            PlayingLine,
            "      audioAttrs=AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_UNKNOWN",
            "      volumeType=LOCAL, controlType=ABSOLUTE, max=0, current=0, volumeControlId=null",
            "      metadata: size=6, description=Aditya Rikhari - Paaro (Official Video), Aditya Rikhari, null",
        };
        var target = new SmartTubeBridge.Shared.Interfaces.PlaybackPosition();

        AdbService.ApplyMetadata(target, lines, 0);

        target.Title.Should().Be("Aditya Rikhari - Paaro (Official Video)");
        target.Artist.Should().Be("Aditya Rikhari");
    }

    [Fact]
    public void Keeps_commas_that_belong_to_the_title()
    {
        var lines = new[]
        {
            PlayingLine,
            "      metadata: size=6, description=Song One, Song Two (Medley), Some Artist, null",
        };
        var target = new SmartTubeBridge.Shared.Interfaces.PlaybackPosition();

        AdbService.ApplyMetadata(target, lines, 0);

        target.Title.Should().Be("Song One, Song Two (Medley)");
        target.Artist.Should().Be("Some Artist");
    }

    [Fact]
    public void Leaves_metadata_empty_when_session_has_none()
    {
        // Observed before SmartTube populates the session.
        var lines = new[] { PlayingLine, "      metadata: size=6, description=null, null, null" };
        var target = new SmartTubeBridge.Shared.Interfaces.PlaybackPosition();

        AdbService.ApplyMetadata(target, lines, 0);

        target.Title.Should().BeNull();
        target.Artist.Should().BeNull();
    }

    [Fact]
    public void Does_not_borrow_metadata_from_the_next_session()
    {
        // SmartTube session has no metadata line; Netflix's block follows.
        var lines = new[]
        {
            PlayingLine,
            "      audioAttrs=AudioAttributes: usage=USAGE_MEDIA",
            "    Netflix media session com.netflix.ninja/Netflix media session (userId=0)",
            "      state=PlaybackState {state=PAUSED(2), position=1, speed=0.0, updated=1}",
            "      metadata: size=6, description=Some Netflix Show, Netflix, null",
        };
        var target = new SmartTubeBridge.Shared.Interfaces.PlaybackPosition();

        AdbService.ApplyMetadata(target, lines, 0);

        target.Title.Should().BeNull();
        target.Artist.Should().BeNull();
    }
}
