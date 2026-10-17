param([ValidateSet('start','stop','check')][string]$Action='check',[ValidateSet('web')][string]$Transport='web')
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime=Join-Path $projectRoot 'records\runtime'
$stateFile=Join-Path $runtime 'services.json'
function Test-Endpoint([string]$Url) {
  try { $request=[Net.HttpWebRequest]::Create($Url); $request.Proxy=$null; $request.Timeout=3000; $response=$request.GetResponse(); $response.Close(); return $true } catch { return $false }
}
if($Action -eq 'check') { foreach($item in @(@('Chat UI / queue','http://127.0.0.1:8789/health'),@('Browser backend','http://127.0.0.1:8787/health'),@('CDP','http://127.0.0.1:9222/json/version'),@('Operator UI','http://127.0.0.1:3030/'))) { Write-Output "$($item[0]): $(Test-Endpoint $item[1])" }; exit 0 }
if($Action -eq 'stop') {
  if(!(Test-Path -LiteralPath $stateFile)) { Write-Output 'No services owned by start.bat. Existing services and browser were kept.'; exit 0 }
  # Cast to a raw array: ConvertFrom-Json wraps a JSON array in a PSObject that
  # would otherwise re-serialize as {"value":[...],"Count":n} on the next start.
  $owned=[object[]](Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json)
  foreach($entry in $owned) {
    $process=Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $entry.started) { Stop-Process -Id $process.Id; Write-Output "Stopped $($entry.name)" }
  }
  [IO.File]::WriteAllText($stateFile,'[]')
  Write-Output 'Browser, login profile, task history, and reused services were kept.'; exit 0
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$node=(Get-Command node.exe -ErrorAction Stop).Source
if(!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\playwright-core'))) { throw 'Dependencies missing. Run npm ci in this folder first.' }
if($Transport -eq 'web') {
  & (Join-Path $projectRoot 'skills\chatgpt-browser-bridge\scripts\start-browser.ps1')
  if($LASTEXITCODE -ne 0) { throw 'Browser startup failed' }
}
$owned=@()
if(Test-Path -LiteralPath $stateFile) { $owned=[object[]](Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json) }
function Start-Owned([string]$Name,[string]$Executable,[string]$Script,[string]$Endpoint) {
  if(Test-Endpoint $Endpoint) { Write-Output "$Name already running; reused."; return }
  if(!(Test-Path -LiteralPath $Script)){throw "Missing service entry: $Script . Update the complete project before starting."}
  $p=Start-Process -FilePath $Executable -ArgumentList ('"'+$Script+'"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime "$Name.log") -RedirectStandardError (Join-Path $runtime "$Name-error.log")
  $entry=@{name=$Name;pid=$p.Id;started=$p.StartTime.ToUniversalTime().Ticks.ToString()}
  $script:owned+=@($entry);[IO.File]::WriteAllText($stateFile,(ConvertTo-Json -InputObject @($script:owned)))
  for($i=0;$i -lt 30;$i++){if(Test-Endpoint $Endpoint){Write-Output "$Name ready.";return};$p.Refresh();if($p.HasExited){throw "$Name exited with code $($p.ExitCode). Check records/runtime/$Name-error.log . Already started services were kept; run stop.bat if needed."};Start-Sleep -Milliseconds 500}
  throw "$Name failed to become ready. See records/runtime logs; run stop.bat to stop owned processes."
}
# Pin the backend port explicitly. The operator launch below sets PORT=3030 in this
# process, and an inherited PORT must not redirect the backend onto the operator port.
$env:PORT='8787'
$env:CHAT_UI_PORT='8789'
if($Transport -eq 'web') {
  Start-Owned 'gpt' $node (Join-Path $projectRoot 'server.mjs') 'http://127.0.0.1:8787/health'
  if(Test-Endpoint 'http://127.0.0.1:8789/health'){
    $gatewayHealth=Invoke-RestMethod 'http://127.0.0.1:8789/health'
    if($gatewayHealth.provider -ne 'chatgpt-web'){throw 'Port 8789 belongs to another provider. Stop the owned old service before starting the web chat.'}
  }
  Start-Owned 'web-ui' $node (Join-Path $projectRoot 'web-gateway.mjs') 'http://127.0.0.1:8789/health'
}
if(!(Test-Endpoint 'http://127.0.0.1:8787/health') -or !(Test-Endpoint 'http://127.0.0.1:8789/health')){throw 'Required backend services are not both ready. Check records/runtime logs.'}
Write-Output 'Required services ready: browser backend 8787, chat / queue 8789.'
if(!(Test-Endpoint 'http://127.0.0.1:3030/')) {
  $install=Join-Path $env:LOCALAPPDATA 'ZCode-CLI'
  $source=if($env:ZCODE_SOURCE){$env:ZCODE_SOURCE}else{Join-Path $install 'ZCode-main'}
  $operatorNode=Join-Path $install 'toolchain\node_modules\node\bin\node.exe'
  $serverScript=Join-Path $source 'packages\server\dist\entry-http.js'
  if(!(Test-Path -LiteralPath $serverScript) -or !(Test-Path -LiteralPath $operatorNode)){Write-Output 'Optional operator runtime not installed; skipped. Chat and queue are available at http://127.0.0.1:8789/ .';exit 0}
  $env:PORT='3030';$env:ZCODE_SERVER_HOST='127.0.0.1';$env:ZCODE_SERVER_WORKSPACE=$projectRoot
  $env:ZCODE_WEB_STATIC_ROOT=Join-Path $source 'packages\web\dist'
  $env:ZCODE_AGENT_SERVER_COMMAND=$operatorNode
  $agentScript=Join-Path $source 'apps\zcode-cli\packages\cli\dist\zcode.cjs'
  if(!(Test-Path -LiteralPath $agentScript)){Write-Output 'Optional operator agent build missing; skipped. Chat and queue are available at http://127.0.0.1:8789/ .';exit 0}
  $env:ZCODE_AGENT_SERVER_ARGS_JSON=ConvertTo-Json -Compress -InputObject @($agentScript,'app-server','--stdio')
  Start-Owned 'operator' $operatorNode $serverScript 'http://127.0.0.1:3030/'
}
Write-Output 'Chat: http://127.0.0.1:8789/ ; Operator: http://127.0.0.1:3030/ . Use stop.bat to stop only owned services.'
