using './main.bicep'

// Manual deployment example only. The pipeline uses environment variables and main.bicep directly.

param namePrefix = 'pda'
param acrName = readEnvironmentVariable('PDA_ACR_NAME')
param webImage = readEnvironmentVariable('PDA_WEB_IMAGE')
param authTenantId = readEnvironmentVariable('PDA_AUTH_TENANT_ID')
param authClientId = readEnvironmentVariable('PDA_AUTH_CLIENT_ID')
param authClientSecret = readEnvironmentVariable('PDA_AUTH_CLIENT_SECRET')
param authTokenStoreSasUrl = readEnvironmentVariable('PDA_AUTH_TOKEN_STORE_SAS_URL')
param azureOpenAiEndpoint = readEnvironmentVariable('PDA_AZURE_OPENAI_ENDPOINT')
param ollamaUseGpu = false
param ollamaModel = 'llama3.1'
param ollamaWorkloadProfileType = 'Consumption-GPU-NC8as-T4'
param immutabilityDays = 365
