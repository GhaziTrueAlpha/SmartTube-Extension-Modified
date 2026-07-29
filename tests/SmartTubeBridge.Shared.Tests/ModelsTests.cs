using FluentAssertions;
using SmartTubeBridge.Shared.Enums;
using SmartTubeBridge.Shared.Models;
using Xunit;

namespace SmartTubeBridge.Shared.Tests;

public class ModelsTests
{
    [Fact]
    public void ApiResponse_Ok_ShouldSetSuccess()
    {
        var resp = ApiResponse.Ok(new { x = 1 }, "done");
        resp.Success.Should().BeTrue();
        resp.Message.Should().Be("done");
        resp.Data.Should().NotBeNull();
    }

    [Fact]
    public void ApiResponse_Fail_ShouldSetError()
    {
        var resp = ApiResponse.Fail("broken", "ERR_1");
        resp.Success.Should().BeFalse();
        resp.Message.Should().Be("broken");
        resp.ErrorCode.Should().Be("ERR_1");
    }

    [Fact]
    public void DeviceInfo_DefaultState_ShouldBeDisconnected()
    {
        var d = new DeviceInfo();
        d.State.Should().Be(DeviceConnectionState.Disconnected);
        d.Transport.Should().Be("usb");
    }

    [Fact]
    public void ServiceStatus_IsConnected_ShouldReflectDeviceState()
    {
        var s = new ServiceStatus
        {
            DeviceState = DeviceConnectionState.Connected
        };
        s.IsConnected.Should().BeTrue();

        s.DeviceState = DeviceConnectionState.Disconnected;
        s.IsConnected.Should().BeFalse();
    }

    [Fact]
    public void LogEntry_ShouldHaveUtcTimestamp()
    {
        var entry = new LogEntry { Level = LogLevel.Info, Source = "test", Message = "hello" };
        entry.Timestamp.Kind.Should().Be(DateTimeKind.Utc);
    }

    [Theory]
    [InlineData(WakeDelay.Ms100, 100)]
    [InlineData(WakeDelay.Ms500, 500)]
    [InlineData(WakeDelay.Ms2000, 2000)]
    public void WakeDelay_ShouldHaveCorrectValues(WakeDelay delay, int expected)
    {
        ((int)delay).Should().Be(expected);
    }

    [Fact]
    public void MediaCommand_ShouldSetAction()
    {
        var cmd = new MediaCommand { Action = MediaAction.PlayPause };
        cmd.Action.Should().Be(MediaAction.PlayPause);
    }

    [Fact]
    public void CastRequest_ShouldStoreUrl()
    {
        var req = new CastRequest { Url = "https://youtube.com/watch?v=abc" };
        req.Url.Should().Be("https://youtube.com/watch?v=abc");
    }
}
