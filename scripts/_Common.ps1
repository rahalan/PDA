<#
.SYNOPSIS
    Shared helpers and configuration for the PDA deployment scripts.
.DESCRIPTION
    Dot-source this file from the other scripts. It centralises configuration
    (read from environment variables so the GitHub Actions workflow stays free of
    logic) and provides small helpers for running native az commands and emitting
    step outputs.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-RequiredEnv {
    param([Parameter(Mandatory)][string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required environment variable '$Name' is not set."
    }
    return $value
}

function Get-OptionalEnv {
    param([Parameter(Mandatory)][string]$Name, [string]$Default = '')
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

function Invoke-Az {
    <# Runs an az command and throws on a non-zero exit code. #>
    param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Arguments)
    Write-Host "az $($Arguments -join ' ')" -ForegroundColor DarkGray
    $result = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "az command failed (exit $LASTEXITCODE): az $($Arguments -join ' ')"
    }
    return $result
}

function Get-PdaConfig {
    <#
        Resolves all deployment configuration into a single object. Names that the
        pipeline must know before the main deployment (the container registry) are
        derived deterministically so build/push can run first.
    #>
    $subscriptionId = Get-RequiredEnv 'AZURE_SUBSCRIPTION_ID'
    $resourceGroup = Get-RequiredEnv 'AZURE_RESOURCE_GROUP'
    $location = Get-OptionalEnv 'AZURE_LOCATION' 'swedencentral'
    $namePrefix = Get-OptionalEnv 'PDA_NAME_PREFIX' 'pda'

    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$subscriptionId/$resourceGroup"))
    $token = ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLower().Substring(0, 12)

    $acrName = Get-OptionalEnv 'PDA_ACR_NAME' ''
    if ([string]::IsNullOrWhiteSpace($acrName)) {
        $acrName = "$($namePrefix)acr$token"
    }
    $acrName = $acrName.ToLower()

    $tokenStoreAccountName = Get-OptionalEnv 'PDA_TOKEN_STORE_ACCOUNT' ''
    if ([string]::IsNullOrWhiteSpace($tokenStoreAccountName)) {
        $tokenStoreAccountName = "$($namePrefix)tok$token"
    }
    $tokenStoreAccountName = $tokenStoreAccountName.ToLower()

    [pscustomobject]@{
        SubscriptionId      = $subscriptionId
        ResourceGroup       = $resourceGroup
        Location            = $location
        NamePrefix          = $namePrefix
        AcrName             = $acrName
        AcrLoginServer      = "$acrName.azurecr.io"
        TokenStoreAccountName = $tokenStoreAccountName
        ImageRepository     = Get-OptionalEnv 'PDA_IMAGE_REPOSITORY' 'pda/web'
        ImageTag            = Get-OptionalEnv 'PDA_IMAGE_TAG' (Get-OptionalEnv 'GITHUB_SHA' 'local')
        OllamaUseGpu        = Get-OptionalEnv 'PDA_OLLAMA_USE_GPU' 'false'
        OllamaModel         = Get-OptionalEnv 'PDA_OLLAMA_MODEL' 'llama3.1'
        OllamaGpuProfileType = Get-OptionalEnv 'PDA_OLLAMA_GPU_PROFILE' 'Consumption-GPU-NC8as-T4'
        OllamaCpuProfileType = Get-OptionalEnv 'PDA_OLLAMA_CPU_PROFILE' 'Consumption'
        DeployAzureOpenAI   = Get-OptionalEnv 'PDA_DEPLOY_AZURE_OPENAI' 'false'
        AzureOpenAiEndpoint = Get-OptionalEnv 'PDA_AZURE_OPENAI_ENDPOINT' ''
        AzureOpenAiDeployment = Get-OptionalEnv 'PDA_AZURE_OPENAI_DEPLOYMENT' 'gpt-4o-mini'
        AzureOpenAiModel    = Get-OptionalEnv 'PDA_AZURE_OPENAI_MODEL' 'gpt-4o-mini'
        DeployerPrincipalId = Get-OptionalEnv 'DEPLOYER_PRINCIPAL_ID' ''
        RepoRoot            = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    }
}

function Set-GitHubOutput {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
    Write-Host "output: $Name=$Value"
    if ($env:GITHUB_OUTPUT) {
        "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    }
}
