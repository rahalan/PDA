# Scaling AI Agents Without Surrendering Enterprise Control

> A practical path to useful, sovereign and auditable enterprise AI

AI agents are moving quickly from experimentation into everyday business workflows. Unlike a conventional assistant that only drafts text, an agent can retrieve records, call APIs, use specialized models and take actions across company systems. That makes agents far more useful. It also changes the risk.

In a single conversation, an employee might move from public research to internal planning and then to a confidential customer record. The agent may cross several models, tools and hosting environments along the way. Most users cannot see those trust-boundary changes, and static access controls do not fully address them.

The strategic question is no longer whether our company will use AI agents. It is whether we can scale their use while keeping the company, rather than an individual agent or technology provider, in control.

We propose an enterprise agent governance foundation designed to do exactly that.

## The opportunity: turn governance into an adoption enabler

Without a common governance layer, every agent initiative must solve the same hard questions independently:

- Which models may process each class of company data?
- Where may that processing occur?
- Which tools and API destinations are permitted?
- What happens when a conversation becomes more sensitive?
- Can we prove which policy was applied and why an action was allowed or refused?

Solving these questions one project at a time creates inconsistent controls, duplicated engineering and slow approvals. It also makes oversight harder as the number of agents grows.

A shared governance foundation changes that equation. The enterprise defines policy once, approved providers supply permitted capabilities, and agents operate within those rules. Product teams can then build useful agent experiences on top of a consistent control plane instead of rebuilding governance for every use case.

This is not governance as a brake on adoption. It is the infrastructure that lets adoption proceed with confidence.

## A simple rule for a complex conversation

The core user promise is straightforward: **as a conversation becomes more sensitive, its protection can increase, but it cannot silently decrease.**

A user begins a chat at a confidentiality level allowed by company policy. If a later prompt or tool request touches protected information, the chat is elevated before that information is released. From that point forward, every model, tool and endpoint must remain eligible for the higher protection level. Returning to lower-confidentiality operation requires a genuinely new chat with separate context.

Execution environment is managed in parallel. Policy may require Public cloud, a named environment based on Restricted Region, or On-premises execution. Once a conversation acquires a stronger environment requirement, subsequent processing must respect it. If no compliant route is available, the agent refuses rather than quietly selecting a less protected provider.

Consider a practical example:

1. An employee starts a Public chat and asks for the weather in Brussels. A permitted public model and weather tool can answer.
2. In the same chat, the employee asks for a confidential sales contract. Before retrieving the record, the system elevates the conversation to Highly Confidential and on-premises processing.
3. The employee then asks an apparently harmless follow-up. The elevated protection remains in force because the confidential context is still part of the conversation.
4. The employee asks the agent to send the summary through a public API. The request is blocked before release, and the reason is recorded.
5. A separate new Public chat can still perform ordinary public work without inheriting the confidential context.

That behavior is understandable to a user, enforceable by the platform and reconstructable by compliance.

## Enterprise policy, enforced at the point of action

The proposed architecture places enterprise-owned policy at the center. Administrators publish signed, versioned policy bundles that define confidentiality and sovereignty levels, approved models, tools and endpoints, and required obligations such as logging and signing.

Policies are expressed using a constrained profile of ODRL, an open policy language for permissions, prohibitions and obligations. Each agent verifies its assigned policy bundle and binds decisions to the exact signed version in use.

Most importantly, policy is evaluated before consequential execution. When an agent proposes a model request or tool call, the governance layer:

1. Identifies the requested action, participant and destination.
2. Determines whether the request requires stronger confidentiality or sovereignty.
3. Checks whether the exact action is allowed at the resulting protection state.
4. Verifies required participant credentials and evidence obligations.
5. Executes only through an authorized route, or refuses.
6. Records the decision and outcome as signed compliance evidence.

This separation matters. The policy decision point determines what is allowed. Enforcement points make that decision effective before data or actions cross a boundary. Model reasoning and prompt instructions cannot override either one.

## Evidence that executives, administrators and auditors can use

The project is designed around three distinct experiences.

**Employees** get a familiar chat interface. Every chat begins Public; explicit confidentiality and environment markers show the current protection state, warnings call out increases and refusals include understandable explanations.

**Administrators** manage policy rather than editing every agent. They can control confidentiality and sovereignty rules, approved models, tools and endpoints, publish signed revisions and see which versions are active.

**Compliance officers** inspect the actual decision record. They can filter by agent, chat, confidentiality, tool call or violation; review the timeline of state changes; inspect policy and participant evidence; and export records to compliance systems.

Each chat produces a signed, append-only sequence of events covering prompts, classification, elevation triggers, requested and executed tool calls, refusals, selected routes, policy versions and credential checks. This makes important questions answerable: What did the agent attempt? Which rule applied? Where was processing permitted? Why did the system allow or block the action?

The distinction between evidence and assurance remains explicit. A participant's signed acceptance of policy is a commitment, not proof of its behavior. A hash-chained application log is tamper-evident, not automatically immutable against a privileged infrastructure operator. Production claims must be backed by the corresponding runtime controls, trusted issuers and storage guarantees.

## Why this approach is strategically valuable

The value extends beyond one demonstration or one agent.

**It creates a reusable control plane.** Common policy, routing and evidence services reduce duplicated work across agent teams and make controls more consistent.

**It keeps authority with the enterprise.** Cloud, sovereign and local providers can all participate, but they do not decide the company's confidentiality or sovereignty rules.

**It supports provider choice without unmanaged fallback.** Models and tools remain replaceable within policy-approved pools. Availability does not become permission to route data somewhere unapproved.

**It gives assurance teams inspectable facts.** Compliance receives a decision trail tied to policy versions and actual outcomes, not a screenshot of what an agent claimed to do.

**It makes refusals useful.** When no compliant path exists, the system explains the constraint instead of hiding it or improvising around it. Those refusals also expose where the business may need another approved capability.

**It prepares us for scale.** A shared foundation is the practical way to govern thousands of agents without turning each deployment into a bespoke negotiation among engineering, security, legal and compliance.

## What we have demonstrated, and what remains to prove

A working local demo now makes the core story tangible using the published GitHub Copilot SDK. It shows a real agent conversation, monotonic confidentiality and sovereignty elevation, governed model and fictional tool routing, policy publication, meaningful refusals and signed compliance events. It includes separate User, Administrator and Compliance experiences.

The demo is intentionally honest about its boundaries. Fictional tools and business records are used for safety. Sending is a dry run. Participant credentials are issued by the demo authority rather than external providers. Provider location is a declaration, not independently attested execution evidence. The ledger is tamper-evident, not a production immutable store, and the local interface assumes one trusted workstation operator rather than enterprise identity and role-based access.

Those limitations are not hidden implementation debt. They define the next validation questions.

## A disciplined path forward

Executive sponsorship would authorize an ordered validation program rather than an immediate fleet-wide rollout:

1. **Confirm the policy model.** Define a manageable enterprise profile for confidentiality, sovereignty and ODRL obligations, including how conflicting requirements produce safe refusals.
2. **Prove the enforcement boundary.** Verify complete mediation for model traffic, tools, endpoints, credentials and retries using representative enterprise integrations.
3. **Establish trustworthy evidence.** Integrate enterprise identity, trusted credential issuers, protected signing keys and storage with independently verifiable retention guarantees.
4. **Measure operational viability.** Test policy-evaluation latency, availability behavior, ledger growth and administrative complexity under realistic workloads.
5. **Pilot a bounded business workflow.** Select a high-value use case with clear data classifications, accountable owners and measurable success criteria.
6. **Set scale gates.** Expand only when security, compliance, user experience and operating-cost evidence meet agreed thresholds.

This sequence directly addresses the principal risks identified in the architecture review: policy-matrix complexity, per-call latency, compromise of the central policy authority, ODRL interoperability, credential overhead and compliance-ledger growth.

## The decision

AI agents will only become more capable and more connected to consequential business systems. Waiting does not remove the governance problem; it leaves each team to solve it independently and makes future consolidation harder.

We have a credible architecture, an executable demonstration and a clear list of claims that still require production-grade proof. The next decision is therefore focused: sponsor a bounded validation and pilot of an enterprise agent governance foundation, with shared ownership across business, security, compliance, architecture and engineering.

The outcome we are seeking is not unrestricted automation. It is something more valuable: agents that can do meaningful work because the enterprise can define the rules, enforce them at runtime and verify what happened afterward.
