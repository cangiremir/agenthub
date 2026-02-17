param(
  [string]$PairingCode,
  [ValidateSet("SAFE", "DEV", "FULL")]
  [string]$Policy = "SAFE"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env.local")) {
  Copy-Item ".env.local.example" ".env.local"
}

$envFile = ".env.local"
$supabaseUrl = (Get-Content $envFile | Where-Object { $_ -match "^SUPABASE_URL=" } | Select-Object -First 1).Split("=", 2)[1]
if (-not $supabaseUrl) {
  $supabaseUrl = "http://127.0.0.1:55321"
}

if (-not $PairingCode) {
  $PairingCode = Read-Host "Pairing code"
}

$name = $env:COMPUTERNAME
if (-not $name) { $name = "Windows Connector" }

$resp = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/functions/v1/pair-device" -ContentType "application/json" -Body (@{
  code = $PairingCode
  agent_name = $name
  device_os = "windows"
  policy = $Policy.ToUpperInvariant()
} | ConvertTo-Json)

if (-not $resp.agent_token) {
  throw "Pairing failed: no agent token returned"
}

$lines = Get-Content $envFile | Where-Object { $_ -notmatch "^CONNECTOR_AGENT_TOKEN=" }
$lines += "CONNECTOR_AGENT_TOKEN=$($resp.agent_token)"
$lines | Set-Content -Encoding utf8 $envFile

Write-Host "Connector token saved to .env.local"
npm --workspace @agenthub/connector run dev
