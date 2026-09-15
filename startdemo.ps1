$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -State Listen -LocalPort 8110 -ErrorAction SilentlyContinue) {
	throw 'Port 8110 is already in use. The demo was not started again.'
}
Start-Process node "`"$PSScriptRoot\server.mjs`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
# The server window is hidden, so surface startup failures (for example a held writer.lock) here.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
	if (Get-NetTCPConnection -State Listen -LocalPort 8110 -ErrorAction SilentlyContinue) {
		Write-Output 'Demo listening on http://127.0.0.1:8110/'
		return
	}
	Start-Sleep -Milliseconds 500
}
throw 'The server did not start listening on 8110. Run "node server.mjs" directly to see the error; a stale writer.lock in the state directory is the most common cause.'