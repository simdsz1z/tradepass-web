$key = $env:OPENAI_API_KEY
$body = @{apiKey=$key; baseUrl="https://api.minimaxi.com"} | ConvertTo-Json -Depth 5
$token = "nPowbm1hn94LNAkoCOKkHYDHctiVtPQtfR3P-2LatXM"

Write-Host "=== Test-key endpoint (now uses MiniMax native) ==="
try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/api/test-key' -Method Post `
        -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Write-Host "BODY: $($r.Content)"
} catch {
    Write-Host "ERR: $($_.Exception.Message)"
}

Write-Host ''
Write-Host "=== Chat endpoint (now uses MiniMax native) ==="
$body2 = @{question="Reply with exactly: pong"} | ConvertTo-Json -Depth 5
try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/api/chat' -Method Post `
        -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body2 -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Write-Host "BODY: $($r.Content)"
} catch {
    Write-Host "ERR: $($_.Exception.Message)"
}
