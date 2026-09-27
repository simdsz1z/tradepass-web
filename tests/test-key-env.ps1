$key = $env:OPENAI_API_KEY
$body = @{
    apiKey = $key
    baseUrl = "https://api.minimaxi.com/v1"
} | ConvertTo-Json -Depth 5

$token = "D2QfkK102RMVwfh415M38hDzatDN4f7EMj2-Nf0APME"
try {
    $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/test-key -Method Post -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body $body -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Write-Host "BODY: $($r.Content)"
} catch {
    Write-Host "ERR: $($_.Exception.Message)"
}
