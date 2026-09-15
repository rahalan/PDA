$serverPath = [regex]::Escape((Join-Path $PSScriptRoot 'server.mjs'))
$demoProcesses = @(Get-CimInstance Win32_Process | Where-Object {
	$_.Name -eq 'node.exe' -and $_.CommandLine -match "(?:^|\s|`")$serverPath(?:`"|\s|$)"
})
$stateDir = if ($env:PDA_STATE_DIR) { $env:PDA_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'PDA/sdk-demo/state' }
$lockPath = Join-Path $stateDir 'writer.lock'
$lockText = if (Test-Path -LiteralPath $lockPath) { Get-Content -LiteralPath $lockPath -Raw } else { $null }
$owner = if ($lockText) { $lockText | ConvertFrom-Json } else { $null }
$demoProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
if ($owner -and $owner.host -eq [System.Net.Dns]::GetHostName() -and $owner.pid -in $demoProcesses.ProcessId -and
	-not (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) -and
	(Test-Path -LiteralPath $lockPath) -and (Get-Content -LiteralPath $lockPath -Raw) -ceq $lockText) {
	Remove-Item -LiteralPath $lockPath -ErrorAction Stop
}
Write-Output 'Stopped matching demo Node processes only. Unowned or pre-existing stale locks were preserved.'