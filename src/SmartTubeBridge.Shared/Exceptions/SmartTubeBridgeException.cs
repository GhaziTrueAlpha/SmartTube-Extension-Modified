namespace SmartTubeBridge.Shared.Exceptions;

public class SmartTubeBridgeException : Exception
{
    public string ErrorCode { get; }

    public SmartTubeBridgeException(string message, string errorCode = "UNKNOWN")
        : base(message)
    {
        ErrorCode = errorCode;
    }

    public SmartTubeBridgeException(string message, Exception inner, string errorCode = "UNKNOWN")
        : base(message, inner)
    {
        ErrorCode = errorCode;
    }
}

public class AdbNotFoundException : SmartTubeBridgeException
{
    public AdbNotFoundException(string? path = null)
        : base(path is null
            ? "ADB executable not found. Install Android SDK Platform Tools or set path in settings."
            : $"ADB not found at: {path}",
            "ADB_NOT_FOUND")
    { }
}

public class DeviceNotConnectedException : SmartTubeBridgeException
{
    public DeviceNotConnectedException(string serial)
        : base($"Device {serial} is not connected or offline.", "DEVICE_OFFLINE")
    { }
}

public class InvalidUrlException : SmartTubeBridgeException
{
    public InvalidUrlException(string url)
        : base($"Invalid or unsupported URL: {url}", "INVALID_URL")
    { }
}
