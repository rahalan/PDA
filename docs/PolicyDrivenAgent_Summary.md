# Policy Driven Agent

> Scaling useful AI agents without surrendering enterprise control

## What a Policy Driven Agent is

A Policy Driven Agent is an AI agent whose authority comes from enterprise policy rather than from the model's instructions or the provider that happens to answer a request. The agent may converse, select a model, request a tool, retrieve information, or attempt an action, but each consequential step is evaluated against a signed policy before execution and before protected results are released.

This matters because an agent conversation is not a single, static transaction. It can begin with an ordinary public question, acquire internal context, select a named regional execution environment or partner boundary, and later request access to a confidential business system. The set of acceptable models, tools, endpoints, and execution environments changes as that context accumulates. A conventional allowlist checked only when the session starts cannot represent that evolution.

The Policy Driven Agent demonstrated in this repository treats governance state as part of the conversation. Every chat begins Public. The governance layer then evaluates prompts and tool requests, raises protection when required, retains the resulting restrictions, chooses only routes eligible for the full state, and refuses actions for which no compliant path exists.

The model does not decide whether the enterprise's rules apply. It operates inside the boundary established by the governance layer.

## What has actually been built

This repository contains a working local demonstration, not only an architecture proposal or a static mockup. It runs a Node.js application on loopback and creates an agent through the published GitHub Copilot SDK. The application has three separate browser experiences:

- **User** provides a simple Public-starting chat, explicit confidentiality and environment markers, visible scope badges, and six guided demonstration stories in a separate sidebar.
- **Administrator** manages the policy draft, constrained ODRL, policy vocabulary, model/tool/environment allowances, fixed model routes, encrypted provider-key entry, signed publication, and demo participant credentials.
- **Compliance** reads the actual application ledger, filters evidence, reconstructs a selected chat timeline, verifies the signed hash chain, and exports evidence for one selected chat.

The current model inventory is GitHub Copilot, local Ollama, Mistral, and SimpleLLM. GitHub Copilot is the public-cloud route for unrestricted synthetic work. Mistral and SimpleLLM are the two remotely configured EU routes available to the Internal model selector. Ollama is the loopback local route used for on-premises execution and for the demonstration's non-EU logical region stories. Provider endpoints are fixed by the application; administrators can enable routes, choose models, and enter keys, but cannot redirect a route to an arbitrary host.

The server loads the governance state and agent when it starts. Application state, signing material, chats, settings, and encrypted provider credentials are kept outside the repository. Provider keys are protected for the current Windows user and are never returned to the browser after entry.

## The governing rule: protection accumulates

The implemented demo uses three governance axes:

1. **Confidentiality**: Public, Internal, or Highly Confidential.
2. **Execution environment**: Public cloud, a named Restricted Region such as Japan, Korea, EU, Brazil, US, or China, or On-premises.
3. **Business scope**: zero or more partner networks and enterprise organizations.

These facts are monotonic within a chat. Confidentiality and base execution protection may become more restrictive but do not silently decrease. Named regions all inherit the Restricted Region base and cannot switch laterally within a chat. Partner-network and enterprise-organization memberships are append-only. Starting a new chat creates a separate Public context; asking a harmless follow-up does not erase restrictions from the existing chat.

The distinction between a named logical environment and physical execution is explicit. Japan, Korea, Brazil, US, and China stories use local Ollama on the demo workstation. They demonstrate that policy can bind a conversation to a named execution environment; they do not claim that inference physically occurred in those countries. The EU routes likewise carry provider-declared location metadata rather than independently attested execution evidence.

## Environment selection and conflict handling

The user does not operate a complex policy console in the chat. Execution environment and business scope are derived from the request and from definitions published by the administrator.

A direct request for Japan, Korea, EU, Brazil, US, or China selects that named execution environment. Partner-network and enterprise-organization definitions can also require an environment. For example, requesting CISPE selects EU, and requesting a country-specific manufacturing organization selects its configured named environment. The evidence records that the environment came from the boundary requirement rather than pretending that the model proved the location.

Once a named regional environment is selected, a request to switch to another named region is refused for that turn with `ENVIRONMENT_CONFLICT`. The prior environment and accumulated business scope remain intact, but the chat is not permanently poisoned; the user can continue with a compatible request. This makes a refusal both protective and usable.

## Policy before models and tools

The active policy is a signed, versioned bundle expressed through a constrained ODRL profile. It defines the protection vocabulary and the models, tools, and execution environments allowed at each confidentiality level. The Administrator can edit a draft through matrices or validated ODRL, preview the resulting policy, and explicitly publish a signed revision.

A new chat is pinned to the policy version and digest active when the chat is created. Publishing a revision does not rewrite the history or authority of an existing chat. This is important for both predictable behavior and auditability: the decision record can identify exactly which policy governed a particular model request or tool action.

Before a model request leaves the application, the governance layer checks the complete conversation state, route configuration, route geography, policy allowance, and participant credential. The model sees only the tools permitted through the SDK session. Native tools and MCP access are not generally exposed by this demo; the application supplies its governed custom-tool catalog.

Tool authorization is also evaluated at the point of use. A requested tool can raise confidentiality, execution posture, or scope before its result is obtained. If that elevation makes the current model route ineligible, the result is withheld and the turn is restarted through an authorized route. If policy forbids the tool at the resulting state, the action is refused before release. A public-send request made after confidential or restricted context has accumulated is therefore blocked rather than treated as harmless because its destination looks public.

## Global service catalog

The demo contains 18 fictional governed services in addition to the generic weather, confidential-sales, and dry-run public-send tools. The catalog is deliberately global:

- Six regional exchange services represent Japan, Korea, EU, Brazil, US, and China.
- Three partner-network services represent the Industrial Community, CISPE, and the NGO Community.
- Five office and research services represent Procurement, HR, Finance, Engineering, and Research.
- Four factory operations services represent Manufacturing China, Manufacturing Japan, Manufacturing Germany, and Manufacturing US.

Each service declares its required execution environment and, where applicable, a partner network or enterprise organization, along with its minimum confidentiality. Tool invocation is real inside the SDK agent flow, while all returned business data is synthetic. Metadata attached to results says that the data and governance claims are fictional, self-declared, and not independently attested.

This catalog is not intended to model eighteen production integrations. It gives the policy and enforcement paths enough variety to demonstrate environment compatibility, cumulative business scope, protected results, environment conflicts, and pre-release refusals without exposing real business systems. Each populated confidentiality/base-environment cell contains between two and four tools.

## The six guided stories

The User view includes a story runner that exercises the normal chat and streaming endpoint. **Next** sends one step, while **Auto** performs a bounded preflight and then advances only when the returned governance state matches the story. Success is based on governance state and refusal codes, not on whether a language model happens to phrase an answer in a particular way.

The stories cover:

1. **Japan manufacturing**: select Japan, add the Industrial Community, then move On-premises for Highly Confidential Manufacturing Japan work.
2. **Korea logistics and HR**: select Korea, refuse an environment switch to Japan without destroying the chat, then move On-premises for Highly Confidential HR work.
3. **EU, CISPE, and Finance**: select EU from CISPE, then add Finance and end at Internal without entering Highly Confidential.
4. **Brazil NGO procurement**: start in Brazil, move On-premises for NGO and Procurement work, and end Internal.
5. **US manufacturing boundary**: select the US environment and Industrial Community, refuse an attempted switch to China, then move On-premises for Highly Confidential Manufacturing US work.
6. **China research and egress**: establish Internal / China and Manufacturing China, move On-premises for Research, then block a public-send attempt before protected information leaves the governed path.

Only one story is specifically EU-centered. The set as a whole demonstrates that the policy model applies consistently across named regional environments rather than treating EU as a special hierarchy.

## Evidence generated by the demo

The application records signed, append-only evidence for the decisions and outcomes it actually observes. Events cover chat creation, prompt classification, protection elevation, scope changes and conflicts, model authorization, provider egress authorization, SDK session activity, tool requests, tool authorization, execution, withheld results, denials, route failures, policy publication, and credential status changes.

The Compliance experience can filter this evidence by agent, chat, confidentiality, execution environment, tool, pre-release outcome, and event type. It displays the selected record, reconstructs the chat timeline, and verifies the ledger's hash chain and signatures. Export is deliberately scoped to the selected chat and includes the pinned policy, relevant demo credentials, signed event records, and a signed manifest over the exported event hashes.

This supports concrete questions:

- What did the user or agent attempt?
- Which protection and scope state was in force?
- What caused that state to change?
- Which policy version and participant credential were checked?
- Which model route or tool was authorized?
- Was a result released, withheld, or denied before release?
- Why was an incompatible region or public egress request refused?

## What the evidence does not prove

The demo distinguishes application evidence from production assurance.

- Demo participant credentials are signed by the demo's own authority. They represent a testable policy-acceptance commitment, not an attestation issued by GitHub, Mistral, SimpleLLM, Ollama, or a tool provider.
- Provider geography is declared configuration and is marked as not attested. Successful provider access does not prove where every inference operation ran.
- Named-region stories that use local Ollama simulate the logical environment. They do not provide in-country execution.
- The ledger is signed and hash-chained, which makes alteration detectable through the application verification path. It is not immutable storage against a privileged workstation or infrastructure operator.
- Synthetic services, records, organizations, and partner networks do not prove integration with real enterprise systems.
- Public send is always a dry run and reports that nothing was delivered.
- The local application assumes a trusted workstation operator. It does not implement enterprise identity, role-based administration, independent key custody, or production retention controls.

These boundaries are part of the demonstration's evidence model. They prevent a working prototype from being described as stronger assurance than it provides.

## What the demo establishes

The implementation establishes that a useful agent experience can remain subordinate to an enterprise-owned control layer. It shows that conversation state can drive model and tool eligibility; that confidentiality, named execution environments, partner networks, and organization restrictions can accumulate; that policy can be changed and signed independently of agent prompts; that protected results can be withheld before release; that incompatible requests can produce precise refusals; and that the resulting decisions can be inspected afterward.

The strategic value is not one particular model, region, or tool. It is the reusable pattern: define authority centrally, bind it to the conversation, enforce it at every consequential boundary, and preserve evidence that can be checked independently of the model's narrative.

That is the Policy Driven Agent demonstrated here.
