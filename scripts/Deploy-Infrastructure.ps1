<#
.SYNOPSIS
    Deploys the PDA infrastructure from infra/main.bicep (Azure Verified Modules).
.DESCRIPTION
    Runs a resource-group scoped Bicep deployment that provisions Log Analytics,
    Application Insights, Key Vault, Storage (SMB state share + unused archive
    container), Container Registry, a user-assigned identity, the Container Apps
    environment, the web app, and the Ollama route (CPU by default, optional serverless GPU).
    Publishes the resulting web URL to the GitHub step output 'webUrl'.
#>

. "$PSScriptRoot/_Common.ps1"

$config = Get-PdaConfig

$webImage = Get-OptionalEnv 'PDA_WEB_IMAGE' "$($config.AcrLoginServer)/$($config.ImageRepository):$($config.ImageTag)"
$deploymentName = "pda-$($config.ImageTag)"
$templateFile = Join-Path $config.RepoRoot 'infra/main.bicep'

$parameters = @(
    "location=$($config.Location)"
    "authTenantId=$(Get-RequiredEnv 'PDA_AUTH_TENANT_ID')"
    "authClientId=$(Get-RequiredEnv 'PDA_AUTH_CLIENT_ID')"
    "hostGeography=$(Get-OptionalEnv 'PDA_HOST_GEOGRAPHY' 'Public cloud')"
    "namePrefix=$($config.NamePrefix)"
    "acrName=$($config.AcrName)"
    "webImage=$webImage"
    "ollamaUseGpu=$($config.OllamaUseGpu)"
    "ollamaModel=$($config.OllamaModel)"
    "ollamaGpuWorkloadProfileType=$($config.OllamaGpuProfileType)"
    "ollamaCpuWorkloadProfileType=$($config.OllamaCpuProfileType)"
)
if (-not [string]::IsNullOrWhiteSpace($config.DeployerPrincipalId)) {
    $parameters += "deployerPrincipalId=$($config.DeployerPrincipalId)"
}
if ($config.DeployAzureOpenAI -eq 'true') {
    $parameters += "deployAzureOpenAI=true"
    $parameters += "azureOpenAiModel=$($config.AzureOpenAiModel)"
    $parameters += "azureOpenAiDeployment=$($config.AzureOpenAiDeployment)"
    $parameters += "azureOpenAiModelVersion=$(Get-OptionalEnv 'PDA_AZURE_OPENAI_MODEL_VERSION' '2024-07-18')"
    $parameters += "azureOpenAiCapacity=$(Get-OptionalEnv 'PDA_AZURE_OPENAI_CAPACITY' '10')"
}
elseif (-not [string]::IsNullOrWhiteSpace($config.AzureOpenAiEndpoint)) {
    # The app rejects anything but this exact form, so fail here instead of at container start.
    if ($config.AzureOpenAiEndpoint -notmatch '^https://[a-z0-9][a-z0-9-]*\.openai\.azure\.com/openai/v1$') {
        throw "PDA_AZURE_OPENAI_ENDPOINT must be exactly https://<resource>.openai.azure.com/openai/v1 (no trailing slash). Got: $($config.AzureOpenAiEndpoint)"
    }
    $parameters += "azureOpenAiEndpoint=$($config.AzureOpenAiEndpoint)"
    $parameters += "azureOpenAiDeployment=$($config.AzureOpenAiDeployment)"
}

else {
    throw 'Configure PDA_DEPLOY_AZURE_OPENAI=true or PDA_AZURE_OPENAI_ENDPOINT. Cloud Copilot login is disabled.'
}

# Mint the EasyAuth token-store SAS from the account bootstrap created earlier.
# Call az directly (not Invoke-Az) so the account key and SAS never reach the logs.
$accountKey = az storage account keys list --account-name $config.TokenStoreAccountName --resource-group $config.ResourceGroup --query '[0].value' --output tsv
if ($LASTEXITCODE -ne 0) { throw "Failed to read the token-store account key for $($config.TokenStoreAccountName)." }
$sasExpiry = (Get-Date).ToUniversalTime().AddYears(2).ToString('yyyy-MM-ddTHH:mm:ssZ')
$sasToken = az storage container generate-sas --account-name $config.TokenStoreAccountName --name tokens --permissions rwdl --expiry $sasExpiry --https-only --auth-mode key --account-key $accountKey --output tsv
if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the token-store container SAS.' }
$tokenStoreSasUrl = "https://$($config.TokenStoreAccountName).blob.core.windows.net/tokens?$sasToken"

$secureFile = [IO.Path]::GetTempFileName()
try {
    if (-not $IsWindows) { [IO.File]::SetUnixFileMode($secureFile, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite) }
    @{
        authClientSecret = @{ value = Get-RequiredEnv 'PDA_AUTH_CLIENT_SECRET' }
        authTokenStoreSasUrl = @{ value = $tokenStoreSasUrl }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $secureFile
    $parameters += "@$secureFile"
    Invoke-Az deployment group validate --resource-group $config.ResourceGroup --template-file $templateFile --parameters $parameters --output none

    $apps = Invoke-Az containerapp list --resource-group $config.ResourceGroup --query '[].name' --output json | ConvertFrom-Json
    $webName = "$($config.NamePrefix)-web"
    if ($webName -in $apps) {
        $revisions = Invoke-Az containerapp revision list --name $webName --resource-group $config.ResourceGroup --query '[?properties.active].name' --output json | ConvertFrom-Json
        foreach ($revision in $revisions) {
            Invoke-Az containerapp revision deactivate --name $webName --resource-group $config.ResourceGroup --revision $revision --output none
        }
    }
    Write-Step "Deploying $deploymentName to $($config.ResourceGroup); brief downtime is expected"
    $outputJson = Invoke-Az deployment group create `
    --resource-group $config.ResourceGroup `
    --name $deploymentName `
    --template-file $templateFile `
    --parameters $parameters `
    --query 'properties.outputs' `
    --output json
} finally {
    Remove-Item -LiteralPath $secureFile -Force
}

$outputs = $outputJson | ConvertFrom-Json
$webUrl = $outputs.webUrl.value
Invoke-RestMethod -Uri "$webUrl/healthz" -TimeoutSec 30 | Out-Null
$anonymous = Invoke-WebRequest -Uri "$webUrl/api/state" -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction SilentlyContinue -TimeoutSec 30
if ($anonymous.StatusCode -notin @(302, 401, 403)) { throw 'Anonymous API access was not rejected; deployment requires investigation.' }

Set-GitHubOutput -Name 'webUrl' -Value $webUrl
Write-Step "Deployment complete. Web URL: $webUrl"
