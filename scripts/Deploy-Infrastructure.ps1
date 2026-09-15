<#
.SYNOPSIS
    Deploys the PDA infrastructure from infra/main.bicep (Azure Verified Modules).
.DESCRIPTION
    Runs a resource-group scoped Bicep deployment that provisions Log Analytics,
    Application Insights, Key Vault, Storage (SMB state share + unused archive
    container), Container Registry, a user-assigned identity, the Container Apps
    environment, the web app, and an Azure OpenAI account with three managed-identity
    model deployments (global/eu/onprem).
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
    authClientSecret             = Get-RequiredEnv 'PDA_AUTH_CLIENT_SECRET'
    hostGeography                = Get-OptionalEnv 'PDA_HOST_GEOGRAPHY' 'Public cloud'
    namePrefix                   = $config.NamePrefix
    acrName                      = $config.AcrName
    webImage                     = $webImage
}
# Role assignments require the *service principal* (Enterprise App) object ID. A raw
# DEPLOYER_PRINCIPAL_ID variable often holds the App Registration's *Application* object ID,
# which Azure rejects (PrincipalTypeNotSupported). Resolve the SP object ID from the logged-in
# OIDC identity so the correct principal type is always used.
$deployerObjectId = $config.DeployerPrincipalId
$ctxAccountId = (Get-AzContext).Account.Id
if (-not [string]::IsNullOrWhiteSpace($ctxAccountId)) {
    $deployerSp = Get-AzADServicePrincipal -ApplicationId $ctxAccountId -ErrorAction SilentlyContinue
    if ($deployerSp) { $deployerObjectId = $deployerSp.Id }
}
if (-not [string]::IsNullOrWhiteSpace($deployerObjectId)) {
    $templateParameters.deployerPrincipalId = $deployerObjectId
}
if ($config.DeployAzureOpenAI -eq 'true') {
    $templateParameters.deployAzureOpenAI      = $true
    $templateParameters.azureOpenAiModel       = $config.AzureOpenAiModel
    $templateParameters.azureOpenAiModelVersion = Get-OptionalEnv 'PDA_AZURE_OPENAI_MODEL_VERSION' '2025-04-14'
    $templateParameters.azureOpenAiCapacity    = [int](Get-OptionalEnv 'PDA_AZURE_OPENAI_CAPACITY' '10')
}
elseif (-not [string]::IsNullOrWhiteSpace($config.AzureOpenAiEndpoint)) {
    # Bring-your-own endpoint: do not also provision an account (deployAzureOpenAI defaults to true).
    $templateParameters.deployAzureOpenAI = $false
    # The app rejects anything but this exact form, so fail here instead of at container start.
    if ($config.AzureOpenAiEndpoint -notmatch '^https://[a-z0-9][a-z0-9-]*\.openai\.azure\.com/openai/v1$') {
        throw "PDA_AZURE_OPENAI_ENDPOINT must be exactly https://<resource>.openai.azure.com/openai/v1 (no trailing slash). Got: $($config.AzureOpenAiEndpoint)"
    }
    $templateParameters.azureOpenAiEndpoint   = $config.AzureOpenAiEndpoint
}
else {
    throw 'Configure PDA_DEPLOY_AZURE_OPENAI=true or PDA_AZURE_OPENAI_ENDPOINT. Cloud Copilot login is disabled.'
}

# Mint the EasyAuth token-store SAS from the account bootstrap created earlier.
$storageKey = (Get-AzStorageAccountKey -ResourceGroupName $config.ResourceGroup -Name $config.TokenStoreAccountName)[0].Value
$storageContext = New-AzStorageContext -StorageAccountName $config.TokenStoreAccountName -StorageAccountKey $storageKey
$sasExpiry = (Get-Date).ToUniversalTime().AddYears(2)
$tokenStoreSasUrl = New-AzStorageContainerSASToken -Context $storageContext -Name 'tokens' -Permission rwdl -ExpiryTime $sasExpiry -Protocol HttpsOnly -FullUri
$templateParameters.authTokenStoreSasUrl = $tokenStoreSasUrl

Initialize-Bicep

# Purge soft-deleted leftovers from a prior teardown that would block recreation of same-named
# resources: Cognitive Services accounts (always purgeable) and Key Vaults that are not
# purge-protected. Best-effort; if anything fails the real deployment error still surfaces.
if (Get-Command az -ErrorAction SilentlyContinue) {
    $previousNativePref = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        az account set --subscription $config.SubscriptionId 2>$null | Out-Null

        $deletedCognitive = az cognitiveservices account list-deleted --query "[?starts_with(name, '$($config.NamePrefix)aoai')].{name:name, location:location}" -o json 2>$null | ConvertFrom-Json
        foreach ($account in @($deletedCognitive)) {
            Write-Step "Purging soft-deleted Cognitive Services account $($account.name)"
            az cognitiveservices account purge --name $account.name --resource-group $config.ResourceGroup --location $account.location --only-show-errors 2>$null | Out-Null
        }

        $deletedVaults = az keyvault list-deleted --query "[?starts_with(name, '$($config.NamePrefix)-kv')].{name:name, protected:properties.purgeProtectionEnabled}" -o json 2>$null | ConvertFrom-Json
        foreach ($vault in @($deletedVaults)) {
            if ($vault.protected) { continue }
            Write-Step "Purging soft-deleted Key Vault $($vault.name)"
            az keyvault purge --name $vault.name --only-show-errors 2>$null | Out-Null
        }
    }
    catch {
        Write-Step "Soft-delete purge step skipped: $($_.Exception.Message)"
    }
    finally {
        $PSNativeCommandUseErrorActionPreference = $previousNativePref
    }
}

$validation = Test-AzResourceGroupDeployment -ResourceGroupName $config.ResourceGroup -TemplateFile $templateFile -TemplateParameterObject $templateParameters -WarningAction SilentlyContinue
if ($validation) { throw "Template validation failed: $(($validation | ForEach-Object { $_.Message }) -join '; ')" }

$webName = "$($config.NamePrefix)-web"
# Stop the previous writer before deploying so the incoming revision can take the single-writer state
# lock cleanly. Uses the az CLI (the Az.App PowerShell module may be absent on the runner). Deactivating
# the old revisions first makes clearing an orphaned writer.lock safe (no live writer can be displaced).
if (Get-Command az -ErrorAction SilentlyContinue) {
    $previousNativePref = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $activeRevisions = @(az containerapp revision list --name $webName --resource-group $config.ResourceGroup --query "[?properties.active].name" -o tsv 2>$null | Where-Object { $_ })
        foreach ($rev in $activeRevisions) {
            Write-Step "Deactivating current revision $rev to release the state lock"
            az containerapp revision deactivate --name $webName --resource-group $config.ResourceGroup --revision $rev --only-show-errors 2>$null | Out-Null
        }
        if ($activeRevisions.Count -gt 0) {
            Start-Sleep -Seconds 15
            $stateAccount = az storage account list --resource-group $config.ResourceGroup --query "[?starts_with(name, '$($config.NamePrefix)st')].name" -o tsv 2>$null | Select-Object -First 1
            if ($stateAccount) {
                $stateKey = az storage account keys list --account-name $stateAccount --resource-group $config.ResourceGroup --query "[0].value" -o tsv 2>$null
                az storage file delete --account-name $stateAccount --account-key $stateKey --share-name 'pda-state' --path 'writer.lock' --only-show-errors 2>$null | Out-Null
            }
        }
    }
    catch {
        Write-Step "Revision/lock cleanup skipped: $($_.Exception.Message)"
    }
    finally {
        $PSNativeCommandUseErrorActionPreference = $previousNativePref
    }
}

Write-Step "Deploying $deploymentName to $($config.ResourceGroup); brief downtime is expected"
$deployment = New-AzResourceGroupDeployment `
    -ResourceGroupName $config.ResourceGroup `
    -Name $deploymentName `
    -TemplateFile $templateFile `
    -TemplateParameterObject $templateParameters

$webUrl = $deployment.Outputs['webUrl'].Value

# Register the EasyAuth callback on the app registration so login works after the environment FQDN
# changes (the domain suffix is regenerated whenever the resource group is recreated). Best-effort:
# needs the deploying principal to own the app registration and a still-valid Graph token; on failure
# it warns and continues (register the reply URL manually in that case).
if (Get-Command az -ErrorAction SilentlyContinue) {
    $previousNativePref = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $clientId = $templateParameters.authClientId
        $callbackUrl = "$webUrl/.auth/login/aad/callback"
        $existingUris = az ad app show --id $clientId --query 'web.redirectUris' -o json 2>$null | ConvertFrom-Json
        $redirectUris = @(@($existingUris) + $callbackUrl | Where-Object { $_ } | Select-Object -Unique)
        Write-Step "Ensuring EasyAuth reply URL $callbackUrl is registered on app $clientId"
        $updateOutput = az ad app update --id $clientId --web-redirect-uris $redirectUris --enable-id-token-issuance true --only-show-errors 2>&1
        # The update is best-effort (the deploying principal may not own the app registration), so verify
        # it actually took effect and surface a loud, actionable warning instead of silently failing login.
        $verifyUris = az ad app show --id $clientId --query 'web.redirectUris' -o json 2>$null | ConvertFrom-Json
        if (@($verifyUris) -notcontains $callbackUrl) {
            Write-Warning "Reply-URL registration did NOT take effect; login will fail with AADSTS50011 until you register it manually:`n  az ad app update --id $clientId --web-redirect-uris `"$callbackUrl`" --enable-id-token-issuance true`n(az output: $updateOutput)"
        }
    }
    catch {
        Write-Step "Reply-URL registration skipped (register it manually if login fails): $($_.Exception.Message)"
    }
    finally {
        $PSNativeCommandUseErrorActionPreference = $previousNativePref
    }
}

# The revision cold-starts (image pull, SMB mount, app boot), so poll until healthy instead of a single request.
$healthDeadline = (Get-Date).AddMinutes(5)
$healthy = $false
do {
    try {
        Invoke-RestMethod -Uri "$webUrl/healthz" -TimeoutSec 15 | Out-Null
        $healthy = $true
    }
    catch {
        if ((Get-Date) -ge $healthDeadline) {
            Write-Step 'Health check failed; dumping recent container logs for diagnosis'
            try {
                $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $config.ResourceGroup | Select-Object -First 1
                if ($workspace) {
                    $kql = @"
union isfuzzy=true ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL
| where ContainerAppName_s == '$webName'
| where TimeGenerated > ago(30m)
| project TimeGenerated, Type, Log_s, Reason_s
| order by TimeGenerated asc
| take 200
"@
                    $logs = Invoke-AzOperationalInsightsQuery -WorkspaceId $workspace.CustomerId -Query $kql
                    foreach ($row in $logs.Results) {
                        Write-Host "[$($row.TimeGenerated)] $($row.Log_s)$($row.Reason_s)"
                    }
                }
                else {
                    Write-Host 'No Log Analytics workspace found in the resource group.'
                }
            }
            catch {
                Write-Host "Log retrieval failed: $($_.Exception.Message)"
            }
            throw "Health check for $webUrl/healthz did not succeed within the warm-up window: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 10
    }
} until ($healthy)

# The app answers /healthz before its single-writer state lock is held, so /api/state can briefly
# return a transient "starting" 503. Poll past that, then assert anonymous access is rejected.
$anonymousStatus = $null
$anonDeadline = (Get-Date).AddSeconds(90)
do {
    $anonymous = Invoke-WebRequest -Uri "$webUrl/api/state" -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction SilentlyContinue -TimeoutSec 30
    $anonymousStatus = $anonymous.StatusCode
    if ($anonymousStatus -in @(302, 401, 403)) { break }
    Start-Sleep -Seconds 5
} while ((Get-Date) -lt $anonDeadline)
if ($anonymousStatus -notin @(302, 401, 403)) { throw "Anonymous API access was not rejected (last status: $anonymousStatus); deployment requires investigation." }

Set-GitHubOutput -Name 'webUrl' -Value $webUrl
Write-Step "Deployment complete. Web URL: $webUrl"
