# Demo test prompts

Requires Node 22.12 or later, the published Copilot SDK 1.0.13 and its platform
runtime, Windows DPAPI dependencies, and an Azure OpenAI (AI Foundry) endpoint with
the three model deployments (`global`, `eu`, `onprem`) reachable via `AZURE_OPENAI_ENDPOINT`.
Dependencies remain under the external demo dependency directory, not in the repository.
These are local walkthrough expectations, not validation of the Azure deployment.

Start:

```powershell
.\startdemo.ps1
```

This starts the Node server on 8110. An occupied demo port is rejected. The server
takes an exclusive state lock before loading the agent. After an abnormal exit, verify
the old process is stopped before an authorized operator removes a stale `writer.lock`.

Open <http://127.0.0.1:8110/> and run these prompts in order.

Default routing is **Public → `global`** (Public cloud), **Internal / EU-only → `eu`** (genuine EU residency — the account runs in an EU region), and **Highly Confidential / On-premises → `onprem`** (simulated: a cloud region is not on-premises). All three routes are Azure OpenAI / AI Foundry deployments on one account, authenticated with the app's managed identity (no API keys). Internal permits no tools in the current policy.

## The three model routes

The Administrator **Route settings** page shows the three routes; there are no API keys or provider pools to configure — all three use the same Azure OpenAI account via managed identity. Each route is one deployment on that account:

- **`global`** → deployment `global`, geography **Public cloud** (genuine).
- **`eu`** → deployment `eu`, geography **EU-only** (genuine: the account runs in an EU region, so processing stays in the EU with a regional `Standard` SKU).
- **`onprem`** → deployment `onprem`, geography **On-premises** (**simulated** — the deployment runs in the cloud, not on-premises; the Admin card and Compliance ledger mark it as simulated).

Probing a route confirms the managed-identity listing call succeeds but does not prove which deployment served a turn or where it ran. Sovereignty is enforced by policy and demonstrated, not independently attested.

| Chat | Prompt | Expected |
| --- | --- | --- |
| New Public | `What is the weather in Brussels? Use the weather tool.` | Public model and fictional weather tool. |
| Same chat | `Summarise these internal, synthetic notes: support improved; onboarding is next. Do not use tools.` | Elevates to **Internal / EU-only** and routes to the EU model (`eu`). |
| Same chat | `Summarise that in one sentence. Do not use tools.` | Stays **Internal / EU-only**. |
| Same chat | `Use public_send to send the public greeting "Hello" to auditor@example.test.` | Refuses the public tool; stays **Internal / EU-only**. |
| Same chat | `Summarise the confidential sales contract SG-104. Use the sales tool.` | Elevates to Highly Confidential / On-premises and routes to the simulated on-premises model (`onprem`) with the approved guard. |
| Same chat | `What does a term of twelve months mean?` | Stays Highly Confidential / On-premises and retains the local requirement. |
| Same chat | `Use public_send to send that summary to auditor@example.test.` | Refuses before delivery. |
| New Public | `Process this request in the EU only. Suggest two headings for a team update. Do not use tools.` | The EU request triggers **Internal / EU-only**, without the word "internal". |
| New Internal | `Suggest two headings for a team update. Do not use tools.` | Starts **Internal / EU-only** without trigger words. |
| New Public | `Retrieve SG-104 using the appropriate lookup tool and give a short summary.` | Tool-triggered elevation happens before data release. |
| New Public | `What is the weather in Brussels? Use the weather tool.` | Does not inherit the protected chat's state. |

**Trigger rules:** whole words `internal` or `EU` select Internal / EU-only. `sales`, `contract`, `private` or `confidential` take precedence and go straight to Highly Confidential / On-premises. An already elevated chat never drops back; use **New chat** for the separate tests.

**Provider check:** a provider refusal is not a missing level. The badges must still show Internal / EU-only. Compliance records each governed egress with its route, geography and simulated flag. Residency is enforced by policy and demonstrated, not independently attested.

## Policy change

1. Allow `public_send` for Public, save, publish, and start a new Public chat.
2. Run `Use public_send to send the public greeting "Hello" to auditor@example.test.`
3. Confirm a dry-run with `delivered: false`.
4. Remove `public_send`, save, publish, and start another new Public chat.
5. Run the same prompt and confirm it is refused.

## Optional refusals

| Setup | Prompt | Expected |
| --- | --- | --- |
| Revoke the weather credential | `What is the weather in Brussels? Use the weather tool.` | Tool refusal. |
| Disable the selected model route | `Reply with one sentence: hello.` | Refusal without provider fallback. |
| Disable the on-premises route, then send a confidential prompt | `Summarise the confidential sales contract SG-104. Use the sales tool.` | No-authorized-route refusal; no model is called. |

Stop:

```powershell
.\stopdemo.ps1
```

This stops only the matching repository's Node processes, preserving unrelated
applications. It removes only a lock owned by the process it just stopped;
unowned/stale locks are left for verified operator recovery.

Azure uses separate Entra sign-in/roles and the three managed-identity Azure OpenAI
deployments (`global`/`eu`/`onprem`). The `eu` route is genuine EU residency; the
`onprem` route is simulated (a cloud region is not on-premises) and is labelled as
such. See [azure-deployment-guide.md](azure-deployment-guide.md). Never submit real
restricted data to the cloud merely to demonstrate governance.
