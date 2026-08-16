# Monitor app connection stability: window title + listener + connections.
$proc = Get-Process -Id 73212 -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output 'app process missing'; exit 1 }
$stable = $true
$last = $proc.MainWindowTitle
for ($i = 1; $i -le 10; $i++) {
  Start-Sleep -Seconds 12
  $p = Get-Process -Id 73212 -ErrorAction SilentlyContinue
  if (-not $p) { Write-Output "check ${i}: PROCESS GONE"; $stable = $false; break }
  $p.Refresh()
  $title = $p.MainWindowTitle
  $listener = [bool](netstat -ano | Select-String '127.0.0.1:3080.*LISTENING' | Select-Object -First 1)
  $conns = @(netstat -ano | Select-String '127.0.0.1:3080.*ESTABLISHED').Count
  if ($title -ne $last -or -not $listener) {
    Write-Output "check ${i}: CHANGED title=[$title] listener=$listener conns=$conns"
    $last = $title
    if ($i -gt 2) { $stable = $false }
  } else {
    Write-Output "check ${i}: stable title=[$title] listener=$listener conns=$conns"
  }
}
Write-Output "RESULT: $stable"
