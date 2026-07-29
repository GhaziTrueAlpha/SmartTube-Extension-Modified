try {
    $stdin = [System.Console]::OpenStandardInput()
    $stdout = [System.Console]::OpenStandardOutput()

    $lenBytes = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $n = $stdin.Read($lenBytes, $read, 4 - $read)
        if ($n -le 0) { exit 0 }
        $read += $n
    }
    $len = [System.BitConverter]::ToUInt32($lenBytes, 0)
    if ($len -eq 0) { exit 0 }

    $msgBytes = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) {
        $n = $stdin.Read($msgBytes, $read, $len - $read)
        if ($n -le 0) { exit 0 }
        $read += $n
    }
    $msg = [System.Text.Encoding]::UTF8.GetString($msgBytes)
    $req = $msg | ConvertFrom-Json

    $adb = if ($req.adbPath) { $req.adbPath } else { "adb" }
    $pkg = if ($req.packageName) { $req.packageName } else { "org.smarttube.stable" }
    $tvIp = $req.tvIp

    $baseArgs = @()
    if ($tvIp) {
        & $adb "connect" "${tvIp}:5555" 2>$null | Out-Null
        $baseArgs = @("-s", "${tvIp}:5555")
    }

    switch ($req.action) {
        "open_url" {
            $shellArgs = $baseArgs + @("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", $req.url, $pkg)
            $output = & $adb $shellArgs 2>&1
            $ok = $LASTEXITCODE -eq 0
        }
        "play_pause" {
            $shellArgs = $baseArgs + @("shell", "input", "keyevent", "85")
            $output = & $adb $shellArgs 2>&1
            $ok = $LASTEXITCODE -eq 0
        }
        "search" {
            $encoded = [System.Uri]::EscapeDataString($req.query)
            $searchUrl = "https://www.youtube.com/results?search_query=$encoded"
            $shellArgs = $baseArgs + @("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", $searchUrl, $pkg)
            $output = & $adb $shellArgs 2>&1
            $ok = $LASTEXITCODE -eq 0
        }
        default {
            $output = "Unknown action: $($req.action)"
            $ok = $false
        }
    }

    $resp = @{ success = $ok; output = "$output" } | ConvertTo-Json -Compress
    $respBytes = [System.Text.Encoding]::UTF8.GetBytes($resp)
    $lenBytes = [System.BitConverter]::GetBytes($respBytes.Length)
    $stdout.Write($lenBytes, 0, 4)
    $stdout.Write($respBytes, 0, $respBytes.Length)
    $stdout.Flush()
}
catch {
    $resp = @{ success = $false; output = "$_" } | ConvertTo-Json -Compress
    $respBytes = [System.Text.Encoding]::UTF8.GetBytes($resp)
    $lenBytes = [System.BitConverter]::GetBytes($respBytes.Length)
    try {
        $s = [System.Console]::OpenStandardOutput()
        $s.Write($lenBytes, 0, 4)
        $s.Write($respBytes, 0, $respBytes.Length)
        $s.Flush()
    } catch {}
}
