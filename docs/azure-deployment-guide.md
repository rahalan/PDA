# PDA on Azure — Deployment Guide

This guide provisions the PDA governance demo to Azure Container Apps using Bicep
(Azure Verified Modules) and GitHub Actions. All Azure logic lives in PowerShell
scripts under `scripts/`; the workflows only orchestrate them.

**Validation status:** a live Azure deployment has now been exercised against a
disposable environment. Verified there: Entra sign-in with app-role isolation, Key
Vault KEK access, the Azure Files (SMB) state mount, and the Azure OpenAI Public
route reaching the model (including a governed tool call once the tool schema was
fixed). GPU readiness, the EU provider routes and telemetry delivery were not
exercised. Several deployment and runtime issues were found and fixed along the way
(see [Troubleshooting](#troubleshooting)); some fixes ship on the next redeploy. Use
synthetic data only.

Eight isolated source regressions cover signed user tokens and role isolation,
HTTP identity binding, state-lock exclusion, versioned key envelopes, pinned-policy
classification, cloud residency refusal, credential-output withholding, and explicit
OpenTelemetry log export. JavaScript/PowerShell syntax and both Bicep templates
pass. The seven direct npm dependencies had no known CVEs in the advisory check;
that is not a transitive-dependency or container-image security assessment.

The archive remains unused and unlocked. The manual parameter example requires
`PDA_ACR_NAME` to match the registry hosting `PDA_WEB_IMAGE`; required values
deliberately have no secret defaults.

## Contents

- [PDA on Azure — Deployment Guide](#pda-on-azure--deployment-guide)
  - [Contents](#contents)
  - [What gets deployed](#what-gets-deployed)
  - [Prerequisites](#prerequisites)
  - [1. Create the Entra app registration and federated credential](#1-create-the-entra-app-registration-and-federated-credential)
  - [2. Grant Azure permissions](#2-grant-azure-permissions)
  - [3. Configure GitHub secrets and variables](#3-configure-github-secrets-and-variables)
  - [4. Deploy via GitHub Actions](#4-deploy-via-github-actions)
  - [5. First-run configuration in the app](#5-first-run-configuration-in-the-app)
  - [Manual / local deployment](#manual--local-deployment)
  - [Configuration reference](#configuration-reference)
  - [Teardown](#teardown)
  - [State recovery](#state-recovery)
  - [Troubleshooting](#troubleshooting)

## What gets deployed

A single resource-group deployment ([infra/main.bicep](../infra/main.bicep)) creates:
Log Analytics, Application Insights, a user-assigned managed identity, Container
Registry, Key Vault (with an RSA KEK), a Storage account (SMB state share + unused
archive container with an unlocked retention policy), a Container Apps environment, the web app, the
Ollama route (CPU on the Consumption profile by default, optional serverless GPU) and — optionally — an Azure OpenAI (AI Foundry) account for the cloud
Public route. See [azure-architecture.md](azure-architecture.md) for the full picture.

Pipeline stages ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)):

| Step | Script | Action |
| --- | --- | --- |
| Azure login | `azure/login@v2` (OIDC) | Federated, secretless sign-in |
| Select subscription | [scripts/Connect-Azure.ps1](../scripts/Connect-Azure.ps1) | `az account set`, verify Bicep |
| Build and push image | [scripts/Build-And-PushImage.ps1](../scripts/Build-And-PushImage.ps1) | Ensure RG + ACR, `az acr build` (no local Docker) |
| Deploy infrastructure | [scripts/Deploy-Infrastructure.ps1](../scripts/Deploy-Infrastructure.ps1) | `az deployment group create` |

## Prerequisites

- An Azure subscription and permission to create resources and role assignments.
- **GPU quota** for Container Apps serverless GPU in your target region only if
  `PDA_OLLAMA_USE_GPU=true` (e.g. `Consumption-GPU-NC8as-T4` in `swedencentral`).
  The default (`PDA_OLLAMA_USE_GPU=false`) runs Ollama CPU-only on the Consumption
  profile and needs no GPU quota, at the cost of slower inference.
- Azure CLI ≥ 2.60 with the Bicep CLI (only for manual deploys).
- A GitHub repository with Actions enabled.
- Node 22.12 or later and PowerShell 7 for manual script execution.
- A separate single-tenant Entra web registration for browser sign-in. Define app
  roles `User`, `Administrator`, and `Compliance`, require user assignment on its
  enterprise application, and assign the appropriate roles. Administrator includes
  chat access, but not Compliance. Enable ID-token issuance, create a client secret,
  and register `https://<web-fqdn>/.auth/login/aad/callback` once the FQDN is known.
  Missing redirect configuration prevents login; application access fails closed.
- A dedicated private blob container for EasyAuth tokens with a scoped, expiring
  container SAS allowing read/write/list/delete. Supply the SAS URL as a GitHub
  environment secret. This prerequisite is separate from the compliance archive.
  Track and rotate both the client secret and token-store SAS.
- Azure public cloud only; national-cloud authorities are not supported by the
  application's signed-token validator.
- **Storage hardening policy:** if the subscription enforces Azure Policy that
  disables storage shared-key access, disables public network access, or denies the
  network default action, the Azure Files SMB state mount fails
  (`VolumeMountFailure: mount error(13)`) and the app cannot reach Key Vault. Every
  resource and the resource group is tagged `SecurityControl: Ignore`, and the
  templates explicitly enable shared-key, public access and `networkAcls
  defaultAction Allow` on the storage accounts and Key Vault. Ensure your
  organization's policy exemption is keyed on that tag (or grant an equivalent
  exemption); the environment is not VNet-injected, so the storage accounts must be
  publicly reachable with shared key.

## 1. Create the Entra app registration and federated credential

In the Entra portal, create `pda-github-deployer` and its enterprise application.
Add a GitHub federated credential with issuer `https://token.actions.githubusercontent.com`,
subject `repo:<OWNER>/<REPO>:environment:production`, and audience
`api://AzureADTokenExchange`. This workflow registration needs no client secret;
do not reuse it for browser login.

> The `subject` must match how the workflow runs. This repo's workflows use
> `environment: production`, so the subject is
> `repo:<OWNER>/<REPO>:environment:production`. For branch-triggered runs without an
> environment, use `repo:<OWNER>/<REPO>:ref:refs/heads/main` instead.

Record the workflow client ID, tenant ID and target subscription ID from the portal.

## 2. Grant Azure permissions

The Bicep bootstrap creates the resource group at subscription scope and uses AVM
for ACR. Have an administrator grant subscription deployment/resource-group creation
permissions and resource-write, ACR build and role-assignment permissions at the
target scope. Use least-privilege custom roles or controlled demo-scope assignments;
resource-group-only credentials cannot run this subscription bootstrap.

Optionally set `DEPLOYER_PRINCIPAL_ID` to the workflow principal object ID so it is
granted **Key Vault Secrets Officer** for seeding secrets.

## 3. Configure GitHub secrets and variables

In **Settings → Secrets and variables → Actions** (and create the `production`
environment):

Secrets:

| Secret | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | app (client) ID from step 1 |
| `AZURE_TENANT_ID` | your tenant ID |
| `AZURE_SUBSCRIPTION_ID` | your subscription ID |
| `PDA_AUTH_CLIENT_ID` | Browser-login registration's application (client) ID |
| `PDA_AUTH_CLIENT_SECRET` | Browser-login registration's client secret |

Variables:

| Variable | Example | Notes |
| --- | --- | --- |
| `AZURE_RESOURCE_GROUP` | `pda-demo-rg` | Created if missing |
| `AZURE_LOCATION` | `swedencentral` | Use a GPU-capable region only when `PDA_OLLAMA_USE_GPU=true` |
| `PDA_NAME_PREFIX` | `pda` | 2–8 lower-case chars/digits |
| `PDA_HOST_GEOGRAPHY` | `Public cloud` | `EU-only` only after verifying hosting and data destinations; never on-premises |
| `PDA_OLLAMA_USE_GPU` | `false` / `true` | Ollama on CPU (default) or serverless GPU |
| `PDA_OLLAMA_MODEL` | `llama3.1` | Model pulled on start |
| `PDA_OLLAMA_GPU_PROFILE` | `Consumption-GPU-NC8as-T4` | GPU profile used when `PDA_OLLAMA_USE_GPU=true`; must match available GPU quota |
| `PDA_OLLAMA_CPU_PROFILE` | `Consumption` | CPU profile used when `PDA_OLLAMA_USE_GPU=false`; serverless `Consumption` or a dedicated size like `D4` |
| `PDA_DEPLOY_AZURE_OPENAI` | `true` / `false` | Provision Azure OpenAI for the cloud Public route |
| `PDA_AZURE_OPENAI_ENDPOINT` | *(v1 endpoint)* | Use an existing Azure OpenAI instead of provisioning |
| `PDA_AZURE_OPENAI_DEPLOYMENT` | `gpt-4.1-mini` | Deployment name the Public route targets |
| `PDA_AZURE_OPENAI_MODEL` | `gpt-4.1-mini` | Model to deploy when provisioning |
| `PDA_AZURE_OPENAI_MODEL_VERSION` | `2025-04-14` | Check regional availability |
| `PDA_AZURE_OPENAI_CAPACITY` | `10` | Thousands of tokens/minute; requires quota |
| `DEPLOYER_PRINCIPAL_ID` | *(SP object ID)* | Optional; grants KV Secrets Officer |

## 4. Deploy via GitHub Actions

- Push to `main` (paths under `app/`, `public/`, `infra/`, `scripts/`, `server.mjs`,
  `package.json`, `Dockerfile`) or run **Deploy PDA to Azure** manually from the
  Actions tab.
- On success, the deploy step prints the public web URL (also available as the
  `deploy` step output `webUrl`).
- Either an existing Azure OpenAI endpoint or new provisioning is required. The
  scripts run isolated regression tests, provision the Bicep bootstrap, build in
  ACR, validate the main deployment, and deactivate old web revisions before update.
  Expect downtime. Both workflows share `pda-production` concurrency; do not bypass
  it with simultaneous manual deployments. Secrets use a temporary parameter file
  removed in `finally`, not logged inline arguments.

## 5. First-run configuration in the app

1. Complete the redirect URI and sign in as an assigned Administrator.
2. Review and **publish** a draft with `azure` allowed for Public, then start a new
  chat. Existing signed policies and credentials are not silently rewritten; a
  new publication issues demo credentials for current participants.
3. In **Route settings**, enable providers and enter API keys for the EU routes
   (Mistral / SimpleLLM). Keys are protected at rest via the Key Vault–backed
   envelope encryption.
4. Set the **Internal model preference** to an allowed provider, including Ollama
  only when its actual host geography satisfies policy.
5. Azure Ollama is not on-premises. On-premises and country-restricted fixture
  requests are refused before model use. Their prompts have already reached the
  cloud web server and may be persisted: use synthetic data only.
6. For an existing Azure OpenAI account, assign **Cognitive Services OpenAI User**
  to the deployed managed identity before use; the template grants this only for
  the account it provisions. Verify an actual Public turn.

> The **cloud Public route** is served by **Azure OpenAI via the managed identity**
> when `PDA_DEPLOY_AZURE_OPENAI=true` (or an existing `PDA_AZURE_OPENAI_ENDPOINT` is
> supplied) — no keys and no interactive sign-in. The Copilot route remains local-only.

## Manual / local deployment

You can deploy from a workstation with Azure CLI (the scripts read the same
environment variables):

```powershell
$env:AZURE_SUBSCRIPTION_ID = '<sub>'
$env:AZURE_RESOURCE_GROUP  = 'pda-demo-rg'
$env:AZURE_LOCATION        = 'swedencentral'
$env:PDA_NAME_PREFIX       = 'pda'

# Also supply the required auth and Azure OpenAI variables listed above.
# Supply secrets privately through your terminal or approved secret manager.

az login
./scripts/Connect-Azure.ps1
./scripts/Build-And-PushImage.ps1
./scripts/Deploy-Infrastructure.ps1
```

Or deploy the template directly (after building/pushing an image):

```powershell
az deployment group create `
  --resource-group pda-demo-rg `
  --parameters infra/main.bicepparam
```

The parameter file is a manual example, not consumed by the pipeline. It reads
required environment variables including `PDA_WEB_IMAGE`, the four `PDA_AUTH_*`
values, and `PDA_AZURE_OPENAI_ENDPOINT`. Direct deployment bypasses writer stop/start
coordination; prefer the scripts.

## Configuration reference

Environment variables read by the deployment scripts
([scripts/_Common.ps1](../scripts/_Common.ps1)):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | yes | — | Target subscription |
| `AZURE_RESOURCE_GROUP` | yes | — | Target resource group (created if missing) |
| `AZURE_LOCATION` | no | `swedencentral` | Region |
| `PDA_NAME_PREFIX` | no | `pda` | Resource name prefix |
| `PDA_ACR_NAME` | no | derived | Registry name (deterministic per sub+RG if unset) |
| `PDA_IMAGE_REPOSITORY` | no | `pda/web` | Image repository |
| `PDA_IMAGE_TAG` | no | `GITHUB_SHA`/`local` | Image tag |
| `PDA_OLLAMA_USE_GPU` | no | `false` | Ollama on CPU (default) or serverless GPU |
| `PDA_OLLAMA_MODEL` | no | `llama3.1` | Ollama model |
| `PDA_OLLAMA_GPU_PROFILE` | no | `Consumption-GPU-NC8as-T4` | GPU workload profile (used when `PDA_OLLAMA_USE_GPU=true`) |
| `PDA_OLLAMA_CPU_PROFILE` | no | `Consumption` | CPU workload profile (used when `PDA_OLLAMA_USE_GPU=false`); serverless `Consumption` or a dedicated size |
| `PDA_DEPLOY_AZURE_OPENAI` | no | `false` | Provision Azure OpenAI for the Public route |
| `PDA_AZURE_OPENAI_ENDPOINT` | no | — | Existing endpoint, exactly `https://<resource>.openai.azure.com/openai/v1` (no trailing slash); the deploy script rejects other forms |
| `PDA_AZURE_OPENAI_DEPLOYMENT` | no | `gpt-4.1-mini` | Deployment name for the Public route |
| `PDA_AZURE_OPENAI_MODEL` | no | `gpt-4.1-mini` | Model to deploy when provisioning |
| `DEPLOYER_PRINCIPAL_ID` | no | — | Grants KV Secrets Officer to the deployer |
| `PDA_WEB_IMAGE` | no | derived | Full image ref (set from the build step) |
| `PDA_AUTH_TENANT_ID` | yes | — | Workflow maps from `AZURE_TENANT_ID` |
| `PDA_AUTH_CLIENT_ID` | yes | — | Browser app client ID |
| `PDA_AUTH_CLIENT_SECRET` | yes | — | Secure EasyAuth credential |

The EasyAuth token store is provisioned automatically: `bootstrap.bicep` creates a
dedicated storage account (`<prefix>tok<token>`) with a `tokens` container, and the
deploy script mints a 2-year container SAS at deploy time and passes it to `main.bicep`.
No `PDA_AUTH_TOKEN_STORE_SAS_URL` secret is required. Override the derived account name
with `PDA_TOKEN_STORE_ACCOUNT` if needed. The SAS expires in 2 years; redeploy to rotate it.

Bicep parameters are documented inline in [infra/main.bicep](../infra/main.bicep).

## Teardown

Run the **Teardown PDA Azure environment** workflow and type `delete` to confirm, or
locally:

```powershell
$env:PDA_DELETE_CONFIRM = 'delete'
./scripts/Remove-Infrastructure.ps1
```

> Key Vault has **purge protection disabled** (soft-delete retention only), so a
> torn-down vault can be purged and re-created without manual recovery. Before the
> main deployment, `Deploy-Infrastructure.ps1` best-effort purges soft-deleted
> Cognitive Services accounts and non-purge-protected Key Vaults left by a prior
> teardown, so redeploys don't collide on reserved names. A Key Vault created by an
> earlier build with purge protection *on* cannot be purged until its retention
> elapses; the current template uses a distinct vault name to avoid that collision.
> The compliance archive is unused and its retention policy is unlocked; no
> immutable evidence is produced.

## State recovery

- New DEK envelopes retain the exact KEK version. Keep that key version enabled and
  recoverable. Legacy raw-base64 wrapped DEKs fail closed rather than guessing a
  version; recover the original key ID before an explicitly approved migration.
- The server acquires `writer.lock` before protector/store initialization. After a
  crash, verify all prior replicas/processes are stopped before an authorized
  operator removes a stale lock. Do not remove a lock solely because an update fails.
- Restart clears interrupted chat busy flags only after writer ownership is acquired.
  A crash between ledger append and checkpoint publication can still require
  restoration of a verified backup. Never fabricate a replacement checkpoint.
- Tests use in-memory or temporary state. No migration of existing state, real
  authentication, model execution, GPU validation or image CVE scan is implied.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `az deployment` fails on GPU profile | No GPU quota in region | Request quota or set `PDA_OLLAMA_USE_GPU=false` to run Ollama CPU-only |
| First Ollama turn refuses with a provider timeout | The GPU replica scales to zero, so the first request also waits for a cold start and the model download, which exceeds the bounded provider attempt | Deploy with `ollamaMinReplicas=1` to keep the route warm (GPU cost applies), or send one throwaway turn to trigger the pull and retry after it completes |
| Login step fails (`AADSTS700...`) | Federated subject mismatch | Ensure the federated credential subject matches the run (environment/branch) |
| Template role-assignment error | Deployer lacks `User Access Administrator` | Grant it at the deployment scope |
| Web app unhealthy after deploy | Image not built / wrong port | Confirm `Build-And-PushImage` ran; probe path is `/healthz` on `8110` |
| Public route errors in cloud | Copilot selected but no cloud model | Set `PDA_DEPLOY_AZURE_OPENAI=true` (or `PDA_AZURE_OPENAI_ENDPOINT`) so Public uses Azure OpenAI |
| Azure OpenAI 401/403 | UAMI missing role or AAD-only auth | Ensure `Cognitive Services OpenAI User` on the account; provisioning sets it automatically |
| App can't unwrap the data key | UAMI missing KV Crypto User or wrong `AZURE_KEY_VAULT_URI` | Verify role assignment and env vars on the container app |
| Container `VolumeMountFailure: mount error(13): Permission denied` | Storage shared-key/public access disabled or firewall `defaultAction Deny` (usually an Azure Policy) | Apply the `SecurityControl: Ignore` tag exemption; the templates set shared-key, public access and `networkAcls defaultAction Allow` |
| `403` (empty body, `x-ms-middleware-request-id` header) on `POST /api/chats` | EasyAuth CSRF mitigation rejects the same-origin POST when the origin isn't approved | The template sets `login.allowedExternalRedirectUrls` to the app's own origin; confirm it matches the current FQDN |
| Login fails `AADSTS500113` (no reply address) / `AADSTS700054` (id_token disabled) | App registration missing the callback reply URL or ID-token issuance | Register `https://<web-fqdn>/.auth/login/aad/callback` and enable ID-token issuance; the deploy step also auto-registers the reply URL when the deployer owns the app registration |
| New revision crash-loops `State is locked` after redeploy | Old and new revisions briefly share the state mount during a rolling deploy, or an orphaned lock remains after a crash | The deploy stops the old revisions and clears any orphaned `writer.lock` before updating; the incoming revision also waits up to 120 s for a graceful release. If it persists, deactivate the old revision and delete `writer.lock` from the `pda-state` share |
| Chat replies "Copilot execution failed" | SDK's native HTTP client found no system CA store | The container image installs `ca-certificates`; confirm that layer is present |
| Chat replies "Azure OpenAI rejected the request (HTTP 400)" | Strict tool schema missing a `required` array | Tool `parameters` include a `required` array listing every property |
