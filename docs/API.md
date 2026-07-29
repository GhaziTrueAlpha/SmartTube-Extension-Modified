# SmartTube Bridge — REST API

Base URL: `http://localhost:8765/api`

All requests and responses use JSON.

## Status

### GET /status
Returns the current service status.

### GET /ping
Health check. Returns `{ "status": "alive" }`.

## Casting

### POST /cast
Send a YouTube URL to SmartTube.

```json
{ "url": "https://www.youtube.com/watch?v=TvmOsxaqTsA", "deviceId": "optional" }
```

### POST /cast/search
Search YouTube on the TV.

```json
{ "query": "never gonna give you up", "deviceId": "optional" }
```

## Media Controls

All endpoints accept an optional JSON body `{ "deviceId": "..." }`.

| Method | Endpoint | Key Event |
|--------|----------|-----------|
| POST | /media/play | KEYCODE_MEDIA_PLAY |
| POST | /media/pause | KEYCODE_MEDIA_PAUSE |
| POST | /media/playpause | KEYCODE_MEDIA_PLAY_PAUSE |
| POST | /media/next | KEYCODE_MEDIA_NEXT |
| POST | /media/previous | KEYCODE_MEDIA_PREVIOUS |
| POST | /media/forward | KEYCODE_MEDIA_FAST_FORWARD |
| POST | /media/rewind | KEYCODE_MEDIA_REWIND |
| POST | /media/stop | KEYCODE_MEDIA_STOP |
| POST | /media/volume/up | KEYCODE_VOLUME_UP |
| POST | /media/volume/down | KEYCODE_VOLUME_DOWN |
| POST | /media/volume/mute | KEYCODE_MUTE |
| POST | /media/home | KEYCODE_HOME |
| POST | /media/back | KEYCODE_BACK |

## Device Management

### GET /devices
List all known devices.

### POST /device/scan
Scan for connected ADB devices.

### POST /device/connect
Connect to a device.

```json
{ "serial": "device_serial" }
// or
{ "ip": "192.168.1.100", "port": 5555 }
```

### POST /device/disconnect
Disconnect a device.

```json
{ "serial": "device_serial" }
```

### POST /device/{id}/prefer
Set a device as the preferred connection.

### DELETE /device/{id}
Remove a device from the saved list.

## Settings

### GET /settings
Returns the current configuration.

### POST /settings
Update configuration. Only provided fields are updated.

## Logs

### GET /logs?max=100&level=Info
Retrieve log entries. Supports `from`, `to`, `level`, and `max` query parameters.

### DELETE /logs/clear
Clear all log files.

## Response Format

All responses follow a consistent envelope:

```json
{
  "success": true,
  "message": "Optional success/error message",
  "data": { ... },
  "errorCode": "ERROR_CODE_IF_FAILED"
}
```
