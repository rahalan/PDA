<#
.SYNOPSIS
    Selects the target subscription for subsequent Azure PowerShell operations.
.DESCRIPTION
    Authentication is performed by the workflow's OIDC login step, which enables an
    Azure PowerShell session. This script only pins the active subscription.
#>

. "$PSScriptRoot/_Common.ps1"

$config = Get-PdaConfig

Write-Step "Setting active subscription to $($config.SubscriptionId)"
Set-AzContext -Subscription $config.SubscriptionId | Out-Null

Write-Step 'Azure context ready'
Get-AzContext | Format-Table Name, Account, Subscription, Tenant
