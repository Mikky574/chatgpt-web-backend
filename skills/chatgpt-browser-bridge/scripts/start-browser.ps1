param(
  [int]$Port = 9222,
  [string]$ProfileDirectory = (Join-Path $env:LOCALAPPDATA 'ChatGPT-CDP-Profile')
)
$ErrorActionPreference = 'Stop'
try {
  $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  if ($version.webSocketDebuggerUrl) {
    Write-Output "CDP already available: http://127.0.0.1:$Port ($($version.Browser))"
    Write-Output 'Existing Chrome was reused; new launch flags require restarting that dedicated CDP browser. Other services may be using it.'
    exit 0
  }
} catch {}
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
)
$chromePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$chromePath) { throw 'Google Chrome was not found.' }
$resolvedProfile = [IO.Path]::GetFullPath($ProfileDirectory)
if ($resolvedProfile.StartsWith([Environment]::GetFolderPath('Windows'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Use a writable user profile directory outside Windows.'
}
New-Item -ItemType Directory -Path $resolvedProfile -Force | Out-Null
Start-Process -FilePath $chromePath -ArgumentList "--remote-debugging-port=$Port",'--remote-debugging-address=127.0.0.1','--remote-allow-origins=*',('"--user-data-dir=' + $resolvedProfile + '"'),'https://chatgpt.com/' -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 15; $attempt++) {
  try {
    $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    if ($version.webSocketDebuggerUrl) {
      Write-Output "CDP ready: http://127.0.0.1:$Port"
      Write-Output "Persistent profile: $resolvedProfile"
      exit 0
    }
  } catch {}
  Start-Sleep -Milliseconds 500
}
throw 'Chrome started but CDP is unavailable. Check the browser window and profile; do not close unrelated browsers.'
