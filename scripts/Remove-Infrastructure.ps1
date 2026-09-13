<#
.SYNOPSIS
    Tears down the PDA deployment.
.DESCRIPTION
    Deletes the resource group. Key Vault has purge protection enabled, so the vault
    is recoverable (not purgeable) until its soft-delete retention elapses. Run this
    only against disposable demo environments.
#>

. "$PSScriptRoot/_Common.ps1"

$config = Get-PdaConfig
if ((Get-RequiredEnv 'PDA_DELETE_CONFIRM') -cne 'delete') { throw 'Set PDA_DELETE_CONFIRM=delete to authorize deletion of the disposable resource group.' }

Write-Step "Deleting resource group $($config.ResourceGroup)"
Remove-AzResourceGroup -Name $config.ResourceGroup -Force | Out-Null

Write-Step "Deletion completed for $($config.ResourceGroup)."
