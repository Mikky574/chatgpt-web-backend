param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference='Stop'
$resolvedRoot=[IO.Path]::GetFullPath($ProjectRoot)
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
if(!$nodeCommand){throw 'Node.js was not found. Install Node.js LTS with npm, then run start.bat again.'}
function Test-ProjectDependencies {
  if(!(Test-Path -LiteralPath (Join-Path $resolvedRoot 'node_modules\playwright-core\package.json'))){return $false}
  Push-Location -LiteralPath $resolvedRoot
  try {
    & $nodeCommand.Source --input-type=module -e "await import('playwright-core')" 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch { return $false } finally { Pop-Location }
}
if(Test-ProjectDependencies){Write-Output 'Project dependencies ready; installation skipped.';return}
$npmCommand=Get-Command npm.cmd -ErrorAction SilentlyContinue
if(!$npmCommand){throw 'npm.cmd was not found. Repair your Node.js/npm installation, then run start.bat again.'}
if(!(Test-Path -LiteralPath (Join-Path $resolvedRoot 'package-lock.json'))){throw 'package-lock.json is missing. Download the complete project before starting; installation was not attempted.'}
Write-Output 'Project dependencies missing or unusable. Installing with npm ci; please wait...'
Push-Location -LiteralPath $resolvedRoot
try {
  & $npmCommand.Source ci --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw "npm ci failed (exit $LASTEXITCODE). Check the npm error above and your registry/network access. Startup stopped; run start.bat again after fixing it."}
}finally{Pop-Location}
if(!(Test-ProjectDependencies)){throw 'npm ci finished but playwright-core cannot be loaded. Check your Node.js version and installation output. Startup stopped.'}
Write-Output 'Project dependencies installed and verified.'
