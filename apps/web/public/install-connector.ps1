param(
  [Parameter(Mandatory = $true)]
  [string]$PairingCode,
  [ValidateSet("SAFE", "DEV", "FULL")]
  [string]$Policy = "SAFE",
  [string]$AppOrigin = "http://127.0.0.1:5173",
  [string]$SupabaseUrl = "http://127.0.0.1:55321"
)

$ErrorActionPreference = "Stop"

$baseDir = Join-Path $env:USERPROFILE ".agenthub-connector"
$envFile = Join-Path $baseDir ".env"
$runnerFile = Join-Path $baseDir "connector-runner.mjs"
$supervisorFile = Join-Path $baseDir "run-connector.ps1"
$pidFile = Join-Path $baseDir "connector.pid"
$logFile = Join-Path $baseDir "connector.log"

New-Item -ItemType Directory -Path $baseDir -Force | Out-Null

$pairBody = @{
  code = $PairingCode
  agent_name = $env:COMPUTERNAME
  device_os = "windows"
  policy = $Policy.ToUpperInvariant()
} | ConvertTo-Json

$resp = Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/functions/v1/pair-device" -ContentType "application/json" -Body $pairBody
if (-not $resp.agent_token) {
  throw "Pairing failed: missing agent token"
}

@(
  "SUPABASE_URL=$SupabaseUrl"
  "CONNECTOR_AGENT_TOKEN=$($resp.agent_token)"
  "CONNECTOR_AGENT_NAME=$($env:COMPUTERNAME)"
  "CONNECTOR_DEVICE_OS=windows"
) | Set-Content -Path $envFile -Encoding utf8

Invoke-WebRequest -UseBasicParsing -Uri "$AppOrigin/connector-runner.mjs" -OutFile $runnerFile

@"
`$ErrorActionPreference = "Continue"
while (`$true) {
  try {
    node "$runnerFile" *>> "$logFile"
    if (`$LASTEXITCODE -eq 42) {
      Add-Content -Path "$logFile" -Value "[supervisor] auth failure, stopping. Re-run installer with fresh pairing code."
      exit 42
    }
  } catch {
    Add-Content -Path "$logFile" -Value "[supervisor] runner crash"
  }
  Start-Sleep -Seconds 2
}
"@ | Set-Content -Path $supervisorFile -Encoding utf8

if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) {
    Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
  }
}

$proc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $supervisorFile) -PassThru -WindowStyle Hidden
$proc.Id | Set-Content -Path $pidFile -Encoding ascii

Start-Sleep -Seconds 1
if ($proc.HasExited) {
  throw "Connector failed to stay running. Check $logFile"
}

Write-Host "Connector runner supervisor started (pid $($proc.Id))"
Write-Host "Log: $logFile"
