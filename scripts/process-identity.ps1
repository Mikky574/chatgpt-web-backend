function Test-ProjectServiceCommand([string]$CommandLine,[string]$ExecutablePath,[string]$ProjectRoot) {
  if([IO.Path]::GetFileName($ExecutablePath) -ne 'node.exe'){return $false}
  foreach($name in @('server.mjs','web-gateway.mjs')){
    $script=[IO.Path]::GetFullPath((Join-Path $ProjectRoot $name))
    $pattern='(?:^|\s)(?:"'+[regex]::Escape($script)+'"|'+[regex]::Escape($script)+')(?=\s|$)'
    if([regex]::IsMatch($CommandLine,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){return $true}
  }
  return $false
}
