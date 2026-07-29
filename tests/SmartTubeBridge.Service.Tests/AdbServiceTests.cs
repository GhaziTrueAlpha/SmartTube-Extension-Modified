using FluentAssertions;
using Moq;
using SmartTubeBridge.Service.Services;
using SmartTubeBridge.Shared.Interfaces;
using SmartTubeBridge.Shared.Models;
using Xunit;

namespace SmartTubeBridge.Service.Tests;

public class AdbServiceTests
{
    private readonly Mock<IConfigService> _configMock = new();
    private readonly Mock<ILogService> _logMock = new();

    public AdbServiceTests()
    {
        _configMock.Setup(c => c.Config).Returns(new AppConfig
        {
            AdbPath = "adb",
            WakeDelayMs = 500
        });
    }

    [Fact]
    public void State_Initial_ShouldBeStopped()
    {
        var svc = new AdbService(_configMock.Object, _logMock.Object);
        svc.State.Should().Be(SmartTubeBridge.Shared.Enums.AdbState.Stopped);
    }
}
