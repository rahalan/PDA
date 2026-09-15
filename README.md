# Policy Driven Agent

Policy Driven Agent is a working demonstration of enterprise governance for AI agents. It shows how an enterprise can retain authority over an agent even when the agent uses different models, invokes tools, crosses business boundaries, and accumulates protected context during a conversation.

The application is built with the published GitHub Copilot SDK and runs as a local Node.js service. It is not only a mockup: prompts flow through a real SDK agent session, model and tool requests are evaluated by the governance layer, policy decisions affect execution, and the resulting events appear in a signed compliance ledger.

The governing principle is straightforward:

> As a conversation acquires more sensitive or restricted context, its protection can increase, but it cannot silently decrease.

Every chat begins Public. The Policy Driven Agent then evaluates what the conversation is asking to use, where the relevant business scope belongs, which model or tool is eligible, and whether a result may be released. The language model does not get to waive enterprise policy. If there is no compliant path, the request is refused.

For a detailed narrative see [docs/PolicyDrivenAgent_Summary.md](docs/PolicyDrivenAgent_Summary.md).

## Why policy must follow the conversation

An enterprise agent conversation is not one fixed transaction. A user may begin with public information, add an internal planning topic, select a named regional execution environment, request a partner service, and later ask for a confidential finance or manufacturing record. Each step can change which models, tools, endpoints, and execution environments are acceptable.

Checking an allowlist only when a chat begins is therefore insufficient. The current state must be evaluated again before model egress, before a tool runs, and before a protected result is returned. The demo makes that state explicit and keeps it attached to the chat.

A new chat starts with separate context. An existing chat cannot become less protected merely because a later prompt appears harmless or because a user would prefer a cheaper or more available route.

## Three governance axes

The current demo tracks three independent governance axes:

1. **Confidentiality** is Public, Internal, or Highly Confidential.
2. **Execution environment** is Public cloud, a named Restricted Region such as Japan, Korea, EU, Brazil, US, or China, or On-premises.
3. **Business scope** is a set of partner networks or enterprise organizations.

Confidentiality and the base execution environment can move only toward stronger protection. Each named region is an execution-environment definition whose base is Restricted Region. A chat cannot switch laterally from one named regional environment to another; an incompatible request is refused for that turn with `ENVIRONMENT_CONFLICT`. Partner networks and enterprise organizations are append-only and can require a particular execution environment.

Requesting CISPE can select the EU environment, while a country-specific manufacturing organization can select its configured named environment. These are normal environment requirements, not a separate regional scope hierarchy.

Named regional environments are logical policy boundaries in this demo. Japan, Korea, Brazil, US, and China stories execute through local Ollama on the workstation. They demonstrate environment enforcement, not physical inference in those countries.

## What the application contains

The browser application has three purpose-specific views.

### User

The User view is intentionally a simple chat. Every conversation begins Public, with explicit confidentiality and execution-environment markers above the prompt. Current scope is visible beside those markers, while the policy version is attached to the chat identifier. Each answer carries its own route information, and alerts explain when protection rises or an action is refused.

While Cairn works, an expanded Activity disclosure streams structured events from the real governance, SDK, model-routing, provider, and tool boundaries. Routine steps stay stone gray. The exact event that raises confidentiality or changes the execution environment uses the destination confidentiality color and states both before and after values. When the turn finishes, the disclosure collapses to a one-line action count and duration with a severity marker; it can be reopened and remains attached to the answer after refresh.

It also includes six guided stories. The runner can advance one prompt at a time or run automatically after a bounded preflight. Story success is evaluated from returned governance state and refusal codes rather than from fragile comparisons against model prose.

### Administrator

The Administrator view manages enterprise policy. It supports:

- Signed and versioned policy publication.
- A constrained ODRL profile with server-side validation.
- Protection-level and execution-environment vocabulary.
- Per-level model, tool, and environment allowances.
- Explicit route configuration for different models.
- Signed demo credentials that can be inspected and revoked.

Published policy versions remain distinct. Each new chat records the active policy version and digest, so a later publication does not rewrite the authority or evidence of an existing conversation.

### Compliance

The Compliance view reads the actual ledger generated by the application. It can filter by agent, chat, confidentiality, execution environment, tool, pre-release outcome, and event type. Selecting a record exposes its details; selecting a chat reconstructs the timeline of classification, elevation, scope, routing, tool, and refusal events.

Ledger verification checks the signed hash chain. Export is limited to the selected chat and contains its records, pinned policy, relevant demo credentials, and a signed manifest of the exported event hashes.

## Models and execution routes

The current route inventory is:

- **GitHub Copilot** for Public cloud synthetic work.
- **Mistral** as an explicitly configured, provider-declared EU route.
- **SimpleLLM** as an explicitly configured, provider-declared EU route.
- **Ollama** on loopback for On-premises execution and named-region stories. Highly Confidential and local work routes through it.

Route endpoints are fixed by the demo so an administrator cannot convert an approved provider entry into arbitrary egress by editing its host.

Before model egress, the application evaluates the chat's full state against the pinned policy, route configuration, allowed geography, and signed participant credential. Provider availability does not create permission to send protected context to an ineligible route.

## Governed tools and synthetic services

The agent exposes governed custom tools through its SDK session. The catalog contains three generic demo tools and 18 governed fictional services:

- Six environment-specific exchanges for Japan, Korea, EU, Brazil, US, and China.
- Three partner-network services for the Industrial Community, CISPE, and the NGO Community.
- Five office and research services for Procurement, HR, Finance, Engineering, and Research.
- Four factory operations services for Manufacturing China, Manufacturing Japan, Manufacturing Germany, and Manufacturing US.

The generic tools are a fictional weather lookup, a confidential sales lookup, and a public-send dry run. Tool invocations use the real governed agent path, but all business results are synthetic. Public send never delivers a message.

Tool minimum requirements cover every supported base cell. Counts are balanced between two and four tools per populated cell; Internal/Public cloud and Highly Confidential/Public cloud remain empty because those combinations are not policy-supported.

| Minimum confidentiality | Public cloud | Restricted Region base | On-premises |
| --- | ---: | ---: | ---: |
| Public | 3 | 4 | 2 |
| Internal | 0 | 4 | 4 |
| Highly Confidential | 0 | 0 | 4 |

A tool request can raise confidentiality, execution posture, or scope before data is released. If the current model is no longer eligible after that change, the result is withheld from that model and the application restarts through an authorized route. If the action itself is forbidden, it is denied before release and the reason is recorded.

## Six global demonstration stories

Every guided story starts in a new Public chat and accumulates scope from left to right:

1. **Japan manufacturing** selects Japan, adds the Industrial Community, and moves On-premises for Highly Confidential Manufacturing Japan work.
2. **Korea logistics and HR** selects Korea, refuses an attempted switch to Japan, then moves On-premises for Highly Confidential HR work.
3. **EU, CISPE, and Finance** selects EU from CISPE and later raises confidentiality for Finance work without becoming Highly Confidential.
4. **Brazil NGO procurement** starts in Brazil, moves to On-premises for NGO and Procurement work, and ends Internal.
5. **US manufacturing boundary** combines the US environment and Industrial Community, refuses a switch to China, then moves On-premises for Highly Confidential Manufacturing US work.
6. **China research and egress** accumulates China, Manufacturing China, and Research, then blocks a public-send attempt before protected information leaves the governed path.

Only one story centers on the EU environment. Together, the six stories demonstrate a global policy model, compatible business-scope accumulation, boundary-selected environments, protected tool use, precise environment conflicts, and pre-release egress refusal.

## Evidence and honest boundaries

The application records signed events for prompts, classifications, protection changes, scope changes, conflicts, model authorization, provider egress, SDK activity, tool requests, tool outcomes, withheld results, denials, policy publication, and credential status. This makes it possible to ask what was attempted, which policy applied, what state was in force, which route was authorized, and whether a result was released or blocked.

The chat Activity disclosure is a sanitized user-facing execution trace, not hidden model chain-of-thought. It exposes concise policy rationale and actual action boundaries without model context, credentials, protected argument values, raw protected results, tokens, or internal paths:

- All business records, services, partner networks, and organizations are fictional.
- Tool calls exercise the application path, but their returned business data is synthetic.
- Public sending is a dry run with `delivered: false`.
- Participant credentials are issued and signed by the demo authority, not by external providers.
- Provider and regional metadata is declared and marked as not independently attested.
- Local Ollama simulates named regional environments; it is not in-country hosting.
- The ledger is signed and tamper-evident, not production immutable storage.
- The local UI assumes a trusted workstation operator and is not an enterprise identity or role-based access implementation.

These limits are visible by design. The demo establishes an executable governance pattern; it does not turn synthetic evidence into a production assurance claim.

## Run the demo

From PowerShell in the repository root:

```powershell
.\startdemo.ps1
```

The script starts local Ollama and the Node.js server. The server loads the governance layer and SDK agent.

Open:

- **User:** <http://127.0.0.1:8110/>
- **Administrator:** <http://127.0.0.1:8110/admin>
- **Compliance:** <http://127.0.0.1:8110/compliance>

For configuration, the complete six-story walkthrough, expected state transitions, and operational limits, see [docs/DEMO.md](docs/DEMO.md).

Stop the demo with:

```powershell
.\stopdemo.ps1
```

## Repository map

- [server.mjs](server.mjs) hosts the loopback API, static application, streaming chat endpoint, ledger APIs, and selected-chat export.
- [app/agent.mjs](app/agent.mjs) creates SDK sessions, constrains available capabilities, mediates model traffic, and runs governed tools.
- [app/governance.mjs](app/governance.mjs) owns policy, conversation state, route eligibility, credentials, elevation, scope, and refusals.
- [app/catalog.mjs](app/catalog.mjs) defines the global scope vocabulary and synthetic service catalog.
- [app/storage.mjs](app/storage.mjs) owns external application state, protected secrets, signed records, and ledger verification.
- [public](public) contains the User, Administrator, and Compliance experiences.
- [docs/DEMO.md](docs/DEMO.md) is the operator walkthrough.
- [docs/PolicyDrivenAgent_Summary.md](docs/PolicyDrivenAgent_Summary.md) is the current explanatory project summary.
