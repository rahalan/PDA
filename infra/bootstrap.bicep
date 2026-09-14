targetScope = 'subscription'

param location string
param resourceGroupName string
param acrName string

@minLength(3)
@maxLength(24)
param tokenStoreAccountName string

var tags = {
  SecurityControl: 'Ignore'
}

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module registry 'br/public:avm/res/container-registry/registry:0.13.0' = {
  name: 'pda-registry-bootstrap'
  scope: group
  params: {
    name: acrName
    location: location
    acrSku: 'Standard'
    acrAdminUserEnabled: false
    tags: tags
  }
}

// EasyAuth token store — provisioned before main.bicep so its container SAS can be
// minted for the web app's auth config. Shared-key access stays on for SAS generation.
module tokenStore 'br/public:avm/res/storage/storage-account:0.33.0' = {
  name: 'pda-token-store-bootstrap'
  scope: group
  params: {
    name: tokenStoreAccountName
    location: location
    kind: 'StorageV2'
    skuName: 'Standard_LRS'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Enabled'
    tags: tags
    blobServices: {
      containers: [
        {
          name: 'tokens'
          publicAccess: 'None'
        }
      ]
    }
  }
}

output tokenStoreAccountName string = tokenStore.outputs.name
