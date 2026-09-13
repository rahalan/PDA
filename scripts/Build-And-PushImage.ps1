<#
.SYNOPSIS
    Builds the web container image inside Azure Container Registry and returns the
    full image reference.
.DESCRIPTION
    Ensures the resource group and registry exist (so the build can run before the
    main infrastructure deployment), then uses `az acr build` to build the Dockerfile
    server-side — no local Docker daemon is required. The resulting image reference is
    written to the GitHub step output 'image'.
#>

. "$PSScriptRoot/_Common.ps1"

$config = Get-PdaConfig
$image = "$($config.AcrLoginServer)/$($config.ImageRepository):$($config.ImageTag)"

foreach ($required in @('PDA_AUTH_TENANT_ID', 'PDA_AUTH_CLIENT_ID', 'PDA_AUTH_CLIENT_SECRET')) { Get-RequiredEnv $required | Out-Null }
if ($config.DeployAzureOpenAI -ne 'true' -and [string]::IsNullOrWhiteSpace($config.AzureOpenAiEndpoint)) { throw 'Configure an Azure OpenAI route before building.' }
$validationRoot = Join-Path ([IO.Path]::GetTempPath()) "pda-validation-$([guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Path $validationRoot | Out-Null
    Copy-Item (Join-Path $config.RepoRoot 'package.json') $validationRoot
    Copy-Item (Join-Path $config.RepoRoot 'server.mjs') $validationRoot
    Copy-Item (Join-Path $config.RepoRoot 'app'), (Join-Path $config.RepoRoot 'tests') $validationRoot -Recurse
    & npm install --prefix $validationRoot --omit=dev --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000
    if ($LASTEXITCODE -ne 0) { throw 'Validation dependencies failed to install.' }
    & node --test --test-timeout=15000 (Join-Path $validationRoot 'tests/regression.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Regression checks failed.' }
} finally {
    if (Test-Path -LiteralPath $validationRoot) { Remove-Item -LiteralPath $validationRoot -Recurse -Force }
}

Write-Step "Provisioning resource group and registry through Bicep/AVM"
Invoke-Az deployment sub create `
    --name "pda-bootstrap-$($config.NamePrefix)" `
    --location $config.Location `
    --template-file (Join-Path $config.RepoRoot 'infra/bootstrap.bicep') `
    --parameters "location=$($config.Location)" "resourceGroupName=$($config.ResourceGroup)" "acrName=$($config.AcrName)" "tokenStoreAccountName=$($config.TokenStoreAccountName)" `
    --output none

Write-Step "Building image $image from $($config.RepoRoot)"
Invoke-Az acr build `
    --registry $config.AcrName `
    --image "$($config.ImageRepository):$($config.ImageTag)" `
    --timeout 1800 `
    --file (Join-Path $config.RepoRoot 'Dockerfile') `
    $config.RepoRoot

Set-GitHubOutput -Name 'image' -Value $image
Write-Step "Image published: $image"
