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

$templateParameters = @{
    location                     = $config.Location
    authTenantId                 = Get-RequiredEnv 'PDA_AUTH_TENANT_ID'
    authClientId                 = Get-RequiredEnv 'PDA_AUTH_CLIENT_ID'
    authClientSecret             = ConvertTo-SecureString (Get-RequiredEnv 'PDA_AUTH_CLIENT_SECRET') -AsPlainText -Force
    hostGeography                = Get-OptionalEnv 'PDA_HOST_GEOGRAPHY' 'Public cloud'
    namePrefix                   = $config.NamePrefix
    acrName                      = $config.AcrName
    webImage                     = $webImage
    ollamaUseGpu                 = ($config.OllamaUseGpu -eq 'true')
    ollamaModel                  = $config.OllamaModel
    ollamaGpuWorkloadProfileType = $config.OllamaGpuProfileType
    ollamaCpuWorkloadProfileType = $config.OllamaCpuProfileType
}
if (-not [string]::IsNullOrWhiteSpace($config.DeployerPrincipalId)) {
    $templateParameters.deployerPrincipalId = $config.DeployerPrincipalId
}
if ($config.DeployAzureOpenAI -eq 'true') {
    $templateParameters.deployAzureOpenAI      = $true
    $templateParameters.azureOpenAiModel       = $config.AzureOpenAiModel
    $templateParameters.azureOpenAiDeployment  = $config.AzureOpenAiDeployment
    $templateParameters.azureOpenAiModelVersion = Get-OptionalEnv 'PDA_AZURE_OPENAI_MODEL_VERSION' '2024-07-18'
    $templateParameters.azureOpenAiCapacity    = [int](Get-OptionalEnv 'PDA_AZURE_OPENAI_CAPACITY' '10')
}
elseif (-not [string]::IsNullOrWhiteSpace($config.AzureOpenAiEndpoint)) {
    # The app rejects anything but this exact form, so fail here instead of at container start.
    if ($config.AzureOpenAiEndpoint -notmatch '^https://[a-z0-9][a-z0-9-]*\.openai\.azure\.com/openai/v1$') {
        throw "PDA_AZURE_OPENAI_ENDPOINT must be exactly https://<resource>.openai.azure.com/openai/v1 (no trailing slash). Got: $($config.AzureOpenAiEndpoint)"
    }
    $templateParameters.azureOpenAiEndpoint   = $config.AzureOpenAiEndpoint
    $templateParameters.azureOpenAiDeployment = $config.AzureOpenAiDeployment
}
else {
    throw 'Configure PDA_DEPLOY_AZURE_OPENAI=true or PDA_AZURE_OPENAI_ENDPOINT. Cloud Copilot login is disabled.'
}

# Mint the EasyAuth token-store SAS from the account bootstrap created earlier.
$storageKey = (Get-AzStorageAccountKey -ResourceGroupName $config.ResourceGroup -Name $config.TokenStoreAccountName)[0].Value
$storageContext = New-AzStorageContext -StorageAccountName $config.TokenStoreAccountName -StorageAccountKey $storageKey
$sasExpiry = (Get-Date).ToUniversalTime().AddYears(2)
$tokenStoreSasUrl = New-AzStorageContainerSASToken -Context $storageContext -Name 'tokens' -Permission rwdl -ExpiryTime $sasExpiry -Protocol HttpsOnly -FullUri
$templateParameters.authTokenStoreSasUrl = ConvertTo-SecureString $tokenStoreSasUrl -AsPlainText -Force

Initialize-Bicep

$validation = Test-AzResourceGroupDeployment -ResourceGroupName $config.ResourceGroup -TemplateFile $templateFile -TemplateParameterObject $templateParameters
if ($validation) { throw "Template validation failed: $(($validation | ForEach-Object { $_.Message }) -join '; ')" }

$webName = "$($config.NamePrefix)-web"
if (Get-Command Get-AzContainerApp -ErrorAction SilentlyContinue) {
    $apps = Get-AzContainerApp -ResourceGroupName $config.ResourceGroup -ErrorAction SilentlyContinue
    if ($apps.Name -contains $webName) {
        $revisions = Get-AzContainerAppRevision -ResourceGroupName $config.ResourceGroup -ContainerAppName $webName | Where-Object Active
        foreach ($revision in $revisions) {
            Disable-AzContainerAppRevision -ResourceGroupName $config.ResourceGroup -ContainerAppName $webName -RevisionName $revision.Name | Out-Null
        }
    }
}

Write-Step "Deploying $deploymentName to $($config.ResourceGroup); brief downtime is expected"
$deployment = New-AzResourceGroupDeployment `
    -ResourceGroupName $config.ResourceGroup `
    -Name $deploymentName `
    -TemplateFile $templateFile `
    -TemplateParameterObject $templateParameters

$webUrl = $deployment.Outputs['webUrl'].Value
Invoke-RestMethod -Uri "$webUrl/healthz" -TimeoutSec 30 | Out-Null
$anonymous = Invoke-WebRequest -Uri "$webUrl/api/state" -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction SilentlyContinue -TimeoutSec 30
if ($anonymous.StatusCode -notin @(302, 401, 403)) { throw 'Anonymous API access was not rejected; deployment requires investigation.' }

Set-GitHubOutput -Name 'webUrl' -Value $webUrl
Write-Step "Deployment complete. Web URL: $webUrl"
