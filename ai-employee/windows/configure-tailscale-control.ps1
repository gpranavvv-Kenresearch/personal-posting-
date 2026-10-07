$ErrorActionPreference = 'Stop'

$candidates = @(
  (Get-Command tailscale -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
  'C:\Program Files\Tailscale\tailscale.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $candidates) {
  throw 'Tailscale is not installed. Run its installer as Administrator first.'
}

$tailscale = @($candidates)[0]
$ip = (& $tailscale ip -4 | Select-Object -First 1).Trim()
if (-not $ip) {
  throw 'Tailscale is installed but not connected. Sign in, then run this script again.'
}

$configPath = (Resolve-Path (Join-Path $PSScriptRoot '..\config.json')).Path
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config.host = $ip
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8

Write-Host "Control center configured for http://${ip}:3210"
Write-Host 'Restart the Ken Research AI Employee scheduled task or sign out and in.'
