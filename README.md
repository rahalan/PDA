# Enterprise Agent Governance

**Trusted sovereign AI agents, built with the GitHub Copilot SDK.**

## Direction and status

This repository is a clean start for an enterprise agent governance demo. The [executive feedback](executive%20feedback.md) is the requirements baseline and takes precedence over the previous design. The agent will use the **GitHub Copilot SDK**, not NemoClaw, OpenClaw or OpenShell.

The approved story has a local demo using the published **GitHub Copilot SDK 1.0.13**. Historical designs are not an active application or compatibility requirement. The requirements below remain the product direction; implementation scope and previously verified local behavior are described in [docs/DEMO.md](docs/DEMO.md).

## Run the live demo

- **User chat:** <http://127.0.0.1:8110/> — a confidentiality selector, prompt box and conversation, with visible protection state.
- **Administrator:** <http://127.0.0.1:8110/admin> — policy drafts and publication, model preferences across the three managed-identity routes, tool allowances and demo credential revocation.
- **Compliance:** <http://127.0.0.1:8110/compliance> — actual signed events, chat timelines, filters, verification and export.

The backend is Node.js with plain HTML/CSS/JavaScript pages. No container or frontend build is required. Model answers come from the real SDK; weather and sales are fictional local services, and sending is dry-run only. Keys are encrypted for the current Windows user, outside the repository.

See [model configuration and walkthrough](docs/DEMO.md). The signed ledger is tamper-evident, not immutable storage; participant credentials are issued by the demo authority, not the external model providers. The local UI assumes one trusted workstation operator, not production role-based authentication. Node 22.12 or later is required.

## Deploy to Azure

An optional Azure deployment hosts the app on Azure Container Apps with Key Vault–backed
at-rest encryption for secrets/signing keys (replacing Windows DPAPI), an unused archive container, and an
Azure OpenAI (AI Foundry) account with three `gpt-4.1-mini` deployments (`global`, `eu`, `onprem`) served by the app's
managed identity — provisioned with Bicep and Azure Verified Modules,
and shipped by GitHub Actions that call PowerShell scripts in [scripts/](scripts).
Cloud behavior is enabled only through environment variables.

Cloud mode requires Entra sign-in and application roles. The `global` route is public
cloud and the `eu` route runs in an EU region (genuine EU residency); the `onprem`
route is a **simulated** on-premises deployment (a cloud region is not on-premises)
and is labelled as such in the UI and ledger. Use synthetic data only. The archive has
no uploader or locked policy; compilation and source tests are not deployment proof.

- [Azure architecture](docs/azure-architecture.md)
- [Azure deployment guide](docs/azure-deployment-guide.md)

## Approved demo story

The approved mockup story is implemented as a simple chat with separate Administrator
and Compliance pages. Follow [docs/DEMO.md](docs/DEMO.md); the old static mockup is
not part of this checkout.

## The story: useful agents without surrendering control

An enterprise agent can read messages, retrieve business data, call tools and choose how to complete a task. That usefulness also makes governance difficult: one conversation can move from public information to confidential records, across tools and model providers, without the user realizing a trust boundary has been crossed.

The goal is an open-source foundation that lets enterprises and their cloud or hosting providers govern that behavior under enterprise-owned policy. Regional and local providers—including the European provider ecosystem represented by [CISPE](https://cispe.cloud/)—can operate the platform without taking sovereignty decisions away from their customers.

**The enterprise defines the rules. Providers supply permitted capabilities. The agent operates within those rules, and compliance can inspect the evidence.**

Azure services can be optional model, tool, identity, key-management or compliance integrations, subject to the same policy checks as other providers. Using the GitHub Copilot SDK does not itself select a compliant model location or establish sovereignty. Fallback is permitted only among routes authorized by the chat's signed policy, protection state, configured pool and valid demo-issued participant credentials.

Portability across sovereign clouds, enterprise infrastructure and on-premises environments remains a useful ambition. Adaptive Apps and Radius from the earlier proposal are possible future packaging options, not prerequisites for this demo.

## What we need to demonstrate

One central policy authority governs agents through signed, versioned ODRL policies. Each chat carries confidentiality and sovereignty state that can become more restrictive but never less restrictive. Model calls, tool calls and API destinations must remain permitted by that state. Every chat produces signed compliance evidence.

The enterprise-scale ambition is governance for thousands of agents. The demo must make the governance behavior understandable and verifiable; it must not claim fleet-scale performance merely because a small demonstration works.

### Three experiences

| Experience | What it shows and controls |
| --- | --- |
| **User** | A chat window, initial confidentiality selection, current confidentiality and sovereignty levels, elevation warnings, and understandable answers or refusals. |
| **Administrator** | An ODRL policy editor, confidentiality and sovereignty matrices, model/tool/API endpoint catalog, policy versions, and controls to publish signed policies to the central directory. |
| **Compliance officer** | A ledger browser with agent and chat drill-down, filters for agent ID, confidentiality, tool calls and violations, a timeline of protection-state changes, and evidence export. |

The executive feedback calls for a mock UI to communicate this story. Any simulated interaction must be identifiable as simulated. A rendered timeline is not proof of enforcement, a mock credential is not provider acceptance, and a scripted answer is not a live Copilot agent run.

## Governance requirements

### 1. Confidentiality follows the conversation

- The user selects the chat's initial confidentiality level from the levels allowed by enterprise policy.
- Prompt analysis and tool requirements can automatically elevate that level.
- Confidentiality can only increase within a chat. A later public question cannot clear an earlier confidential context.
- All subsequent model and tool calls must satisfy the elevated state, including calls caused by retrieved content.
- Lower-confidentiality operation requires a genuinely new chat with separate context; confidential history must not be copied into it behind the scenes.

User selection establishes the starting state, not permission to downgrade known source restrictions. Public, Internal and Highly Confidential are useful illustrative labels from the earlier story; the administrator defines the actual levels and their permissions.

### 2. Sovereignty is a separate, persistent state

- Enterprise policy defines permitted computation environments, such as public cloud, sovereign cloud, EU-only hosting and on-premises.
- Prompts and tools can add stronger sovereignty requirements. Once elevated, the chat retains those restrictions for future actions.
- Confidentiality and sovereignty are evaluated together but remain distinct facts. A confidentiality label is not a country or hosting guarantee.
- Elevation narrows the permitted execution environments. Geographic and hosting requirements are not always a single ladder: incompatible requirements must produce a refusal, not a silently broadened route.
- If no permitted model, tool or endpoint is available, the agent explains the refusal without substituting a less protected option.

### 3. Every tool call is governed

A runtime integration inspects each proposed tool request before execution. A weather lookup and a confidential sales database query have different protection requirements even when requested in the same conversation.

The governed sequence is:

1. Resolve the tool identity, requested operation, arguments and API endpoint against the active policy and trusted tool metadata.
2. Determine whether the request requires confidentiality or sovereignty elevation; record and retain the required state change.
3. Evaluate the exact action against that effective state. Elevation does not grant permission to a forbidden tool.
4. Verify the required policy-acceptance credentials and evidence obligations before releasing the call.
5. Execute only through the permitted path, record the outcome, and retain any additional restrictions discovered in the result before further model or tool use.

The same protection state constrains model requests and API destinations. A confidential tool result must not return to a now-ineligible model simply because that model began the conversation.

### 4. Central policies are signed, versioned and enforceable

The central directory stores enterprise-wide policies defining:

- Confidentiality levels and sovereignty levels.
- Allowed models, tools and API endpoints for each applicable policy combination.
- Permissions, prohibitions and obligations expressed in **ODRL**.
- Policy versions and the signing information needed to verify bundles.

Administrators publish signed bundles. Agents fetch and verify their assigned bundle at startup and provide evidence of the specific signed version in use. Decisions and chat records bind to that version; merely displaying a version string is insufficient.

Signing, logging and other mandatory obligations must be enforced by the governed runtime integration. Unsupported mandatory policy terms or an unverifiable bundle must not become best-effort permissions. The ODRL profile, evaluator and distribution technology remain implementation choices to resolve against these requirements.

### 5. Models and tools provide verifiable policy acceptance

Models and tools must supply verifiable credentials recording that their responsible service or provider:

- Saw the policy.
- Accepted the policy.
- Commits to behave according to it.

The compliance record retains these credentials and their binding to the participant and signed policy version. Credential verification must account for issuer trust, validity and status.

**Acceptance is a signed commitment, not proof of actual behavior.** Runtime enforcement and observed evidence remain necessary. An agent-generated statement, an API key or a gateway signing on its own behalf cannot be presented as an external provider's acceptance. Where a provider cannot supply the required credential, that gap must remain visible and the credential-dependent action must be withheld. Synthetic participants may demonstrate the protocol only when clearly labelled.

### 6. Every chat produces compliance evidence

The required compliance ledger is signed and append-only, with an immutable record for each chat and a reconstructable sequence of events containing:

- Agent and chat identity, event ordering and correlation.
- Prompts and classification analysis.
- The trigger for each confidentiality or sovereignty elevation, with before/after state.
- Tool requests, actual calls, outcomes and refusals.
- Effective sovereignty level and selected model/tool/API endpoint.
- The signed policy version used for each decision.
- Policy-acceptance credentials from tools and models.
- Policy decisions, obligation outcomes and detected violations or suspicious attempts.

Compliance officers must be able to audit a specific chat or agent and export verifiable records to compliance systems. Prompt-bearing logs are themselves sensitive data and require appropriate access, residency and retention controls; signing does not make their contents public.

An application-level hash chain can demonstrate tamper detection. It does not, on its own, prove storage immutability against a privileged host operator. The implementation must state which immutability guarantees its storage and independent verification actually provide.

## Architecture responsibilities

The [GitHub Copilot SDK](https://github.com/github/copilot-sdk) supplies the agent runtime integration and agent loop. The enterprise governance layer owns authoritative policy, protection state, authorization and compliance evidence. Model reasoning and tool output cannot rewrite that authority.

| Component | Responsibility |
| --- | --- |
| Central policy directory and publisher | Store, version and distribute signed ODRL policy bundles. |
| Copilot SDK agent host | Bind agent/chat identity, load verified policy, run the real agent loop and integrate governed execution. |
| Chat protection authority | Maintain initial confidentiality, inferred requirements and monotonic confidentiality/sovereignty state. |
| Policy decision point | Decide whether a model, tool or endpoint action is permitted and identify required obligations. |
| Policy enforcement points | Enforce those decisions before consequential execution or data release; a refusal cannot become an unmanaged retry. |
| Credential verification | Validate and retain participant policy-acceptance credentials for the policy version in use. |
| Compliance ledger and exporter | Record signed events, support verification and expose authorized audit/export views. |

This preserves the useful distinction from the original proposal: **a policy decision point decides; a policy enforcement point makes the decision effective.** Policy, verified identity claims, the requested action and existing evidence are separate inputs. Prompt instructions alone are not an enforcement boundary.

SDK callbacks and tool permissions are integration mechanisms, not automatic proof of complete mediation. Built-in tools, model traffic, subprocesses, network access and credentials must be assessed when defining the actual enforcement boundary. The old OpenShell security guarantees do not transfer merely by replacing its runtime name with Copilot SDK.

## Demonstration storyline

**Cumulus Granitus — your hardened cloud** remains the fictional provider used to tell the story. It hosts an enterprise's governed agent service; the enterprise administrator owns the policy and the compliance officer independently inspects the record. All business records and organizations used in the demo are fictional.

The following is an ordered walkthrough of the new requirements, not the previous six-slice plan. Protection mappings are illustrative until authored in the demo policy.

1. **Publish the rules.** The administrator configures confidentiality and sovereignty matrices, approved models/tools/endpoints and obligations, then publishes a signed ODRL bundle to the central directory.
2. **Show which rules the agent accepted.** The agent starts with a verified bundle. Its identity and exact policy version are visible, alongside the policy-acceptance credentials of participating tools and model services.
3. **Start an ordinary chat.** The user selects Public confidentiality and requests a low-risk weather lookup. The agent uses a permitted tool and model; the current protection state is visible.
4. **Cross into enterprise data.** The user asks about a fictional confidential sales record or contract. Before protected access, the chat elevates to the confidentiality and sovereignty required by that source—for example, Highly Confidential and on-premises. The user sees what triggered the change.
5. **Show that protection sticks.** The user follows up with an apparently public question. The chat retains its elevated state and uses only models and tools still permitted at that state.
6. **Demonstrate a meaningful refusal.** A request to send the confidential material through a public API is blocked before release. The user sees the reason; compliance sees the attempted action, policy and refusal. If no compliant model exists, the agent refuses rather than choosing an unapproved provider.
7. **Begin a separate low-protection chat.** A fresh Public chat can use the public tool without inheriting confidential context from the previous chat. The protected chat and its audit history remain unchanged.
8. **Publish a policy revision.** The administrator changes an allowance and publishes a newly signed version. A newly started agent loads that version; previous evidence continues to identify the version used at the time. Existing-chat update semantics must be explicit, never a silent downgrade.
9. **Audit the complete story.** The compliance officer filters by agent, confidentiality, tool and violation, reviews the elevation timeline, inspects credentials and policy versions, and exports the selected chat's verifiable record.

These beats carry forward the earlier demo's strongest ideas: fictional enterprise documents, policy-controlled model/tool access, understandable refusals, a policy change without rewriting the agent, and independently inspectable evidence. Cheapest-model selection, a particular public tool provider and the old UI layout are not acceptance requirements of the new feedback.

## Design risks to resolve

| Risk from executive review | Design question |
| --- | --- |
| Dual-matrix complexity | How are confidentiality and sovereignty composed without contradictory rules or an unmanageable cross-product? |
| Per-call policy latency | How can evaluation remain responsive without stale authorization or skipping required checks? |
| Central policy-store compromise | How are publisher authority, signing keys, version integrity and distribution access protected? |
| ODRL interoperability | Which constrained enterprise-agent profile expresses the required permissions, prohibitions and enforceable obligations? |
| Credential overhead | Can credentials be reused or batched per participant/policy version while still checking validity and status for each governed use? |
| Ledger growth | How are indexing, export, retention and archival handled at fleet scale without silently rewriting committed history? |

Additional implementation decisions include trusted classification, SDK model/egress integration, isolated new-chat state, policy refresh behavior, credential issuer participation and the evidence needed to claim immutability. Resolve these in the new design rather than inheriting unexamined choices from the archive.

## Repository guide

- [Executive feedback](executive%20feedback.md): authoritative requirements, preserved as supplied.
- [Working agreements](AGENTS.md): current development constraints for the clean start.
- [License](LICENSE): retained project license.

The active backend is [server.mjs](server.mjs), with governance, storage and SDK integration under app/ and separate browser views under public/. [docs/DEMO.md](docs/DEMO.md) records the walkthrough and limitations. Archived code is not imported or built.
