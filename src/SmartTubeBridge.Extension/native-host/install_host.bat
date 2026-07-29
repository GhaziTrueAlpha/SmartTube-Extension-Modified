@echo off
setlocal
set "MANIFEST=%~dp0com.smarttube.extension.json"

echo.
echo === SmartTube Native Messaging Host Installer ===
echo.
echo This registers the native host so Chrome can launch it.
echo.
echo BEFORE running this:
echo   1. Load the extension in Chrome (chrome://extensions -^> Load unpacked)
echo   2. Copy the extension ID shown in your extension popup
echo   3. Paste it into 'com.smarttube.extension.json' replacing YOUR_EXTENSION_ID_HERE
echo   4. Then run this installer
echo.
echo Press any key when ready, or Ctrl+C to cancel...
pause >nul

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.smarttube.extension" /ve /t REG_SZ /d "%MANIFEST%" /f
if %ERRORLEVEL% EQU 0 (
    echo Registered for Chrome.
) else (
    echo Failed to register for Chrome.
)

reg add "HKCU\Software\Chromium\NativeMessagingHosts\com.smarttube.extension" /ve /t REG_SZ /d "%MANIFEST%" /f 2>nul

echo.
echo Done. Reload the extension (chrome://extensions -^> reload icon).
echo.
pause
