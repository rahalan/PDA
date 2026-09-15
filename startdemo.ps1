Get-NetTCPConnection -LocalPort 8110 -State Listen -ErrorAction SilentlyContinue |
	Select-Object -ExpandProperty OwningProcess -Unique |
	ForEach-Object { Stop-Process -Id $_ -Force }

if (-not (Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(ollama( app)?|llama-server|ollama_llama_server)\.exe$' })) {
	Start-Process ollama serve -Environment @{ OLLAMA_MAX_VRAM = '42949672960' } -WindowStyle Hidden
}

Start-Process node "$PSScriptRoot\server.mjs" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
