# PDA on Azure — Deployment Guide

This guide provisions the PDA governance demo to Azure Container Apps using Bicep
(Azure Verified Modules) and GitHub Actions. All Azure logic lives in PowerShell
scripts under `scripts/`; the workflows only orchestrate them.

**Validation status:** an earlier single-route Azure deployment was exercised against a
disposable environment. Verified there: Entra sign-in with app-role isolation, Key
Vault KEK access, the Azure Files (SMB) state mount, and an Azure OpenAI route reaching
the model (including a governed tool call once the tool schema was fixed and the proxy
stripped SDK-injected fields such as `stream_options`/`reasoning_effort`). The
three-deployment topology (`global`/`eu`/`onprem`) is the current design; re-verify
after deploying it. Several deployment and runtime issues were found and fixed along the
way (see [Troubleshooting](#troubleshooting)). Use synthetic data only.

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
  - [Adding a model route](#adding-a-model-route)
  - [Teardown](#teardown)
  - [State recovery](#state-recovery)
  - [Troubleshooting](#troubleshooting)

## What gets deployed

A single resource-group deployment ([infra/main.bicep](../infra/main.bicep)) creates:
Log Analytics, Application Insights, a user-assigned managed identity, Container
Registry, Key Vault (with an RSA KEK), a Storage account (SMB state share + unused
archive container with an unlocked retention policy), a Container Apps environment, the web app, and an
Azure OpenAI (AI Foundry) account with three `gpt-4.1-mini` deployments (`global`/`eu`/`onprem`)
served by the app's managed identity. See [azure-architecture.md](azure-architecture.md) for the full picture.

Pipeline stages ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)):

| Step | Script | Action |
| --- | --- | --- |
| Azure login | `azure/login@v2` (OIDC) | Federated, secretless sign-in |
| Select subscription | [scripts/Connect-Azure.ps1](../scripts/Connect-Azure.ps1) | `az account set`, verify Bicep |
| Build and push image | [scripts/Build-And-PushImage.ps1](../scripts/Build-And-PushImage.ps1) | Ensure RG + ACR, `az acr build` (no local Docker) |
| Deploy infrastructure | [scripts/Deploy-Infrastructure.ps1](../scripts/Deploy-Infrastructure.ps1) | `az deployment group create` |

## Prerequisites

- An Azure subscription and permission to create resources and role assignments.
- **Azure OpenAI capacity** for `gpt-4.1-mini` in your target region — three deployments
  are created (10K TPM each by default; adjust `PDA_AZURE_OPENAI_CAPACITY`). Use an EU
  region (e.g. `swedencentral`) so the `eu` route's residency claim is genuine.
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
| `AZURE_LOCATION` | `swedencentral` | Use an EU region so the `eu` route's residency is genuine |
| `PDA_NAME_PREFIX` | `pda` | 2–8 lower-case chars/digits |
| `PDA_DEPLOY_AZURE_OPENAI` | `true` / `false` | Provision the Azure OpenAI account and the three deployments (default `true`) |
| `PDA_AZURE_OPENAI_ENDPOINT` | *(v1 endpoint)* | Use an existing Azure OpenAI account instead of provisioning; it must already have `global`/`eu`/`onprem` deployments |
| `PDA_AZURE_OPENAI_MODEL` | `gpt-4.1-mini` | Model deployed for all three deployments when provisioning |
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
2. The published policy already allows `global` (Public), `eu` (Internal / EU-only) and
  `onprem` (Highly Confidential / On-premises). Start a new chat. Existing signed
  policies and credentials are not silently rewritten.
3. In **Route settings**, review the three routes. There are no API keys or provider
  pools — all three use the same Azure OpenAI account via managed identity. The `eu`
  route is genuine EU residency; the `onprem` route is labelled **simulated**.
4. The default routing needs no changes: Public → `global`, Internal/EU → `eu`,
  Highly Confidential → `onprem`.
5. The `onprem` route runs in the cloud, not on-premises, and is labelled simulated.
  Prompts reach the cloud web server and may be persisted: use synthetic data only.
6. For an existing Azure OpenAI account, assign **Cognitive Services OpenAI User**
  to the deployed managed identity before use; the template grants this only for
  the account it provisions. Verify an actual Public turn.

> All three routes are served by **Azure OpenAI via the managed identity** when
> `PDA_DEPLOY_AZURE_OPENAI=true` (the default) or an existing `PDA_AZURE_OPENAI_ENDPOINT`
> is supplied — no keys and no interactive sign-in. The account uses AAD-only auth
> (`disableLocalAuth: true`).

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
| `PDA_DEPLOY_AZURE_OPENAI` | no | `true` | Provision the Azure OpenAI account and the three deployments |
| `PDA_AZURE_OPENAI_ENDPOINT` | no | — | Existing endpoint, exactly `https://<resource>.openai.azure.com/openai/v1` (no trailing slash); the deploy script rejects other forms and skips provisioning. Must already have `global`/`eu`/`onprem` deployments |
| `PDA_AZURE_OPENAI_MODEL` | no | `gpt-4.1-mini` | Model deployed for all three deployments when provisioning |
| `PDA_AZURE_OPENAI_CAPACITY` | no | `10` | Thousands of tokens/minute per deployment |
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

## Adding a model route

The set of model routes is a **deploy-time catalog**, not a runtime list. It is defined by
`settings-cloud/models.settings.json` (or the base `settings/`), loaded once at boot. The Admin
UI can **tune existing routes** — name, model (deployment) name, endpoint (only among each route's
`approvedBaseUrls`), enable/disable, cost score, API keys, per-level preferred route, and EU routing
order — but it **cannot add a new route**; `updateSettings` rejects any unknown route id. This keeps
each route's geography (sovereignty) and egress URL allow-list under reviewed, deploy-time control.

To add a new model route, edit the settings and redeploy:

1. **`models.settings.json`** — add a route object: `id`, `kind` (`azure-openai`, `openai-compatible`,
   `ollama`, or `copilot`), `name`, `enabled`, `model` (the Azure *deployment* name), `baseUrl`,
   `approvedBaseUrls` (the egress allow-list), `geography` (`Public cloud` / `region-eu` /
   `On-premises`), `costScore`, `discovery`, and `requiredForDemo`. Add it to a `preferences`
   `allowedRouteIds` (and `routingPools` if it should participate in the EU pool).
2. **`policy.settings.json`** — add the route id to `allowedModels` for each protection level it may
   serve, and add a `routeEnvironmentDeclarations` entry describing its residency basis.
3. **`credentials.settings.json`** — add a matching participant (`kind: "model"`).
4. For a provisioned Azure OpenAI account, add the corresponding deployment in
   [infra/main.bicep](../infra/main.bicep) (or point `baseUrl` at an existing one).
5. Redeploy, then re-seed the policy so the new `allowedModels` takes effect: deploy once with
   `reseedPolicy=true` / `PDA_RESEED_POLICY=1`, then set it back — or do a clean resource-group deploy.

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
- The server acquires `writer.lock` before protector/store initialization. The lock is a
  heartbeat lease: an incoming replica reclaims it automatically once the previous holder's
  heartbeat is stale (>60 s), so an ungraceful crash self-heals. Only remove a lock by hand
  if recovery is stuck; verify all prior replicas/processes are stopped first.
- Restart clears interrupted chat busy flags only after writer ownership is acquired.
  A crash between ledger append and checkpoint publication can still require
  restoration of a verified backup. Never fabricate a replacement checkpoint.
- The governance policy is **seeded once** from the deployment settings and then persisted
  (signed) to `policies.json` on the state share; `credentials.json` and `policy-draft.json`
  follow the same rule. Later edits to the `settings*/` files are picked up only on a boot where
  no stored policy exists (e.g. a clean resource-group deploy that recreates the share). To apply
  settings changes without recreating the share, boot once with `PDA_RESEED_POLICY=1` (opt-in):
  it discards the stored policy/credentials/draft, re-seeds from the in-image settings, and appends
  a `policy-reseeded` ledger event. Set it back to `0`/remove it afterward — while it is set, every
  container restart re-seeds and discards Admin policy edits.
- Tests use in-memory or temporary state. No migration of existing state, real
  authentication, model execution or image CVE scan is implied.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `az deployment` fails creating a model deployment | `gpt-4.1-mini` capacity/quota exhausted in the region | Lower `PDA_AZURE_OPENAI_CAPACITY` or request more quota; three deployments each consume TPM |
| Login step fails (`AADSTS700...`) | Federated subject mismatch | Ensure the federated credential subject matches the run (environment/branch) |
| Template role-assignment error | Deployer lacks `User Access Administrator` | Grant it at the deployment scope |
| Web app unhealthy after deploy | Image not built / wrong port | Confirm `Build-And-PushImage` ran; probe path is `/healthz` on `8110` |
| Model route errors in cloud | No Azure OpenAI account/deployments | Set `PDA_DEPLOY_AZURE_OPENAI=true` (default) or point `PDA_AZURE_OPENAI_ENDPOINT` at an account that has `global`/`eu`/`onprem` deployments |
| Azure OpenAI 401/403 | UAMI missing role or AAD-only auth | Ensure `Cognitive Services OpenAI User` on the account; provisioning sets it automatically |
| App can't unwrap the data key | UAMI missing KV Crypto User or wrong `AZURE_KEY_VAULT_URI` | Verify role assignment and env vars on the container app |
| Container `VolumeMountFailure: mount error(13): Permission denied` | Storage shared-key/public access disabled or firewall `defaultAction Deny` (usually an Azure Policy) | Apply the `SecurityControl: Ignore` tag exemption; the templates set shared-key, public access and `networkAcls defaultAction Allow` |
| `403` (empty body, `x-ms-middleware-request-id` header) on `POST /api/chats` | EasyAuth CSRF mitigation rejects the same-origin POST when the origin isn't approved | The template sets `login.allowedExternalRedirectUrls` to the app's own origin; confirm it matches the current FQDN |
| Login fails `AADSTS500113` (no reply address) / `AADSTS700054` (id_token disabled) | App registration missing the callback reply URL or ID-token issuance | Register `https://<web-fqdn>/.auth/login/aad/callback` and enable ID-token issuance; the deploy step also auto-registers the reply URL when the deployer owns the app registration |
| New revision crash-loops `State is locked` after redeploy | Old and new revisions briefly share the state mount during a rolling deploy, or an orphaned lock remains after a crash | The deploy stops the old revisions and clears any orphaned `writer.lock` before updating; within a revision the heartbeat lease auto-reclaims a stale lock (~60 s) so restarts self-heal. If it persists beyond ~2 min, deactivate the old revision and delete `writer.lock` from the `pda-state` share |
| Settings/policy change not taking effect after an image redeploy (e.g. `ROUTE_NOT_PERMITTED` persists) | The policy is seeded once and persisted to `policies.json` on the state share; the updated `settings*/` files only seed on a boot with no stored policy | Redeploy once with `reseedPolicy=true` (Bicep) / `PDA_RESEED_POLICY=1`, then set it back to false. Ad-hoc: `az containerapp update -n <web> -g <rg> --set-env-vars PDA_RESEED_POLICY=1` then `--remove-env-vars PDA_RESEED_POLICY`. A clean resource-group deploy also re-seeds automatically |
| Chat replies "Copilot execution failed" | SDK's native HTTP client found no system CA store | The container image installs `ca-certificates`; confirm that layer is present |
| Chat replies "Azure OpenAI rejected the request (HTTP 400)" | Strict tool schema missing a `required` array, or the SDK injected fields Azure rejects (`stream_options`, `reasoning_effort`, `snippy`) | Tool `parameters` include a `required` array; the proxy forwards only an allow-list of standard chat-completions fields |
