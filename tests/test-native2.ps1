$key = $env:OPENAI_API_KEY
$body = @{apiKey=$key; baseUrl="https://api.minimaxi.com"} | ConvertTo-Json -Depth 5
$token = "wGr0m35XKns993o4qc0vdmD6nNMSjW8cU591yku2i38"

Write-Host "=== Test-key endpoint (MiniMax native) ==="
try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/api/test-key' -Method Post `
        -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Write-Host "BODY: $($r.Content)"
} catch { Write-Host "ERR: $($_.Exception.Message)" }

Write-Host ''
Write-Host "=== Chat endpoint (MiniMax native) ==="
$body2 = @{question="Reply with exactly: pong"} | ConvertTo-Json -Depth 5
try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/api/chat' -Method Post `
        -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body2 -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Write-Host "BODY: $($r.Content.Substring(0, [Math]::Min(800, $r.Content.Length)))"
} catch { Write-Host "ERR: $($_.Exception.Message)" }
