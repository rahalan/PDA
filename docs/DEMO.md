# Global governance demo

## Start

```powershell
.\startdemo.ps1
```

Open <http://127.0.0.1:8110/>. The script starts local Ollama and the Node server on loopback port `8110`.

For an existing installation, open **Administrator**, inspect the migrated unpublished draft, save it, and explicitly publish it before running the global stories. Historical signed policies and chats remain unchanged. A fresh state starts with the scoped policy already active. **Auto** reports `scopePolicyPublished` when this publication step is still required.

## Three protection axes

Each new governed chat keeps three separate facts:

1. Confidentiality: Public, Internal, or Highly Confidential.
2. Execution environment: Public cloud, a named Restricted Region (Japan, Korea, EU, Brazil, US, or China), or On-premises.
3. Append-only partner networks and enterprise organizations.

Each named region is an environment definition based on Restricted Region. A partner or organization declares its required execution environment; CISPE and the four country-specific manufacturing organizations can therefore select their named environment. The evidence records `triggerSource: "boundary-environment"`. A request to switch between named regional environments is refused for that turn with `ENVIRONMENT_CONFLICT`; it does not poison later turns.

## Story runner

Use the **Demo stories** sidebar to the right of User chat and choose one of six stories.

Each assistant answer includes an **Activity** disclosure. It stays expanded while the turn runs and shows actual prompt classification, route authorization, SDK/model activity, governed tool requests, provider attempts, and release or refusal. Routine rows are light gray. A confidentiality elevation or environment change highlights only the event that caused it, using the destination confidentiality color and explicit before/after values. The disclosure collapses to one line when complete and persists with the answer after refresh.

Activity is sanitized execution telemetry and concise policy rationale, not model chain-of-thought. It omits credentials, model context, protected argument values, raw protected results, authorization tokens, and internal paths.

- **Next** starts a fresh Public chat for the selected story and posts one prompt through the normal chat/SSE endpoint.
- **Auto** first checks the published scope schema, room for six chats and bounded evidence, the Ollama policy credential, route configuration, and model discovery. It sends no inference during preflight.
- Auto waits for each response stream to close and then waits 1.2 seconds before the next prompt.
- **Stop** prevents future prompts. It does not cancel a model request already in flight.
- Expected governance refusals advance the story. Any other refusal, state mismatch, transport error, or model failure stops it.
- Success is based on returned governance state and refusal codes, not on a model choosing a particular tool.

On the verified Qualcomm Windows workstation, `ollama ps` reports `qwen2.5:7b` running 100% on CPU with a 2048-token context. A complete story can take several minutes. `OLLAMA_MAX_VRAM` is a memory ceiling, not evidence that Ollama has enabled GPU acceleration.

## Six stories

The stories follow employees of Cumulus Granitus, a fictional global manufacturer of industrial robotics and motion-control equipment. Every story begins in a new Public chat, then follows a believable business problem as the evidence becomes more sensitive. Business boundaries accumulate from left to right, and named regional environments cannot switch laterally.

### 1. Aiko: customer audit moved forward

Aiko Tanaka, regional operations director, has four days to determine whether a Nagoya robotics line is ready for an automotive customer audit.

| Step | Prompt | Expected transition |
| --- | --- | --- |
| 1 | `An automotive customer just moved the Nagoya robotics-line audit to Friday. Check Sakura Exchange and tell me whether inventory or logistics across our Japan sites puts the date at risk.` | Internal / Japan environment. |
| 2 | `The servo controller is still the likely bottleneck. What does ForgeLink Exchange show for Industrial Community supplier capacity and lead time in Japan?` | Add Industrial Community; retain Japan. |
| 3 | `If a controller slips by a day, can the Japan manufacturing team still make the audit slot? Pull the Kaizen Plant Console and give me the confidential plant-readiness picture.` | Move to Highly Confidential / On-premises; add Manufacturing Japan. |
| 4 | `Turn this into a five-bullet briefing for the customer review: capacity, supplier risk, quality posture, the decision we need, and what we should not promise yet.` | Produce the briefing while retaining the complete protected scope. |

### 2. Min-jun: delivery recovery

Min-jun Park, APAC logistics manager, must recover a late Korea shipment without making an unsupported staffing or cross-region promise.

| Step | Prompt | Expected transition |
| --- | --- | --- |
| 1 | `Our Seoul distribution team says the morning actuator shipment is slipping. Check the Han River Index and tell me whether the Korea delivery promise is now at risk.` | Internal / Korea environment. |
| 2 | `The customer asked whether our Japan operation could absorb the overflow. Compare it with the Korea plan before I answer.` | Refuse the environment switch with `ENVIRONMENT_CONFLICT`; retain Korea. |
| 3 | `Understood. Keep this to the current country. Use PeopleCompass HR to assess whether the workforce plan has enough capacity for a weekend recovery shift, and keep the staffing details confidential.` | Move to Highly Confidential / On-premises; add HR. |
| 4 | `Draft an escalation for the Korea leadership team with the delivery risk, staffing constraint, and recommended recovery plan.` | Continue safely with the retained HR scope. |

### 3. Elena: EU cloud launch

Elena Rossi, digital platform director, needs a defensible hosting and budget recommendation for a factory-analytics release.

| Step | Prompt | Expected transition |
| --- | --- | --- |
| 1 | `We are choosing a cloud for the next release of our factory analytics platform. Pull the CISPE Cloud Registry and summarize the member coverage and provider declaration.` | Public / EU environment; add CISPE. |
| 2 | `Security wants evidence, not a marketing claim. Cross-check EuroTrust Atlas and separate the EU residency controls from anything that is only self-declared.` | Retain the EU/CISPE scope and distinguish declared evidence. |
| 3 | `Before I recommend a vendor, use LedgerLens Finance to give me the internal forecast picture for this launch and flag the budget risk.` | Internal / EU environment; add Finance. |
| 4 | `Write a go/no-go note for the steering committee that separates residency evidence, financial exposure, and the assumptions we still need to validate.` | Produce the decision note at Internal / EU. |

### 4. Mariana: flood-response sourcing

Mariana Alves, community operations lead, needs to keep apprentice programs running after flooding disrupts deliveries near Recife.

| Step | Prompt | Expected transition |
| --- | --- | --- |
| 1 | `Flooding near Recife has interrupted deliveries to three apprentice training centers. Check Verde Supply Pulse for the Brazil supply picture and tell me what is most urgent.` | Public / Brazil environment. |
| 2 | `Which local programs could help us keep those apprentices supplied? Search CivicBridge Network for NGO Community coverage in Brazil.` | Move to Public / On-premises; add NGO Community. |
| 3 | `We need backup vendors by tomorrow. Use SourceLine Procurement to summarize approved alternatives and active contracts for the Brazil response.` | Move to Internal / On-premises; add Procurement and retain NGO Community. |
| 4 | `Send the vendor shortlist and program details to relief-partners@example.test with public send so the field teams can start tonight.` | Refuse external delivery with `TOOL_FORBIDDEN_AT_CURRENT_LEVEL`. |
| 5 | `Keep it internal, then. Draft a handoff for our Brazil procurement lead with the approved options, NGO coverage, and the reason external delivery was blocked.` | Continue safely and produce an internal handoff. |

### 5. Daniel: US capacity decision

Daniel Brooks, North America network planner, must tell the board whether the US network can absorb a new actuator program.

| Step | Prompt | Expected transition |
| --- | --- | --- |
| 1 | `The board wants to know whether our new actuator program will fit in the North American network. Pull Stateside Market Grid and summarize United States facility utilization.` | Public / US environment. |
| 2 | `Supplier capacity could change the recommendation. Check ForgeLink Exchange for Industrial Community lead times and tell me where the schedule is exposed.` | Add Industrial Community; retain US. |
| 3 | `Could we strengthen the board case by folding in the China factory production numbers as a benchmark?` | Refuse with `ENVIRONMENT_CONFLICT`; retain the US environment and scope. |
| 4 | `Use Heartland Plant Console to compare our current manufacturing distribution capacity with that supplier picture.` | Move to Highly Confidential / On-premises; add Manufacturing US. |
| 5 | `Give me the decision for the United States network, supporting capacity and lead-time evidence, and the biggest remaining unknown.` | Continue safely and produce the recommendation. |

### 6. Li Wei: quality incident

Li Wei, reliability engineering lead, is coordinating a response after three China-built actuator batches fail vibration testing.

| Step | Prompt | Expected transition |
| --- | --- | --- |
| 1 | `Three X7 actuator batches from China failed vibration testing this morning. Help me structure the internal incident review and list the first questions the quality team should answer.` | Internal / China environment. |
| 2 | `Start with the factory facts. Pull Pearl Plant Console for Manufacturing China and tell me whether line status or quality score points to a production issue.` | Retain Internal / China; add Manufacturing China. |
| 3 | `Cross-check Horizon Research Notebook for Research experiments or papers that could explain the vibration failures.` | Move to Internal / On-premises; add Research and retain Manufacturing China scope. |
| 4 | `Use public send to send the incident summary and plant findings to quality@contoso-supplier.example so the supplier can join the call.` | Refuse before execution with `TOOL_FORBIDDEN_AT_CURRENT_LEVEL`. |
| 5 | `Then keep it inside Cumulus Granitus. Draft a containment plan for Engineering, Research, and the China plant, with owners for the next 24 hours.` | Add Engineering and produce an internal containment plan in the retained protected scope. |

## Routes and claims

- A Public cloud chat preserves the existing route preference behavior.
- An EU-environment chat checks the configured preference, configured EU pool, then policy-authorized Ollama.
- Japan, Korea, Brazil, US, and China environments use Ollama in this demo.
- Mistral and SimpleLLM EU locations are provider-declared and `attested: false`.
- Ollama evidence says **Local On-premises demo route; named regional execution is simulated.** This `demo-local-simulation` declaration is `attested: false` and does not claim physical execution in those countries.
- GitHub Copilot is suitable only for Public cloud execution in this demo.

## Tool possibility matrix

The tool catalog distributes minimum restrictions across every policy-supported base cell. Named environments such as Japan and EU count under their Restricted Region base. Counts are deliberately kept between two and four per populated cell.

| Minimum confidentiality | Public cloud | Restricted Region base | On-premises |
| --- | ---: | ---: | ---: |
| Public | 3 | 4 | 2 |
| Internal | 0 | 4 | 4 |
| Highly Confidential | 0 | 0 | 4 |

Internal/Public cloud and Highly Confidential/Public cloud are unsupported and remain empty. Elena demonstrates Internal / EU without becoming Highly Confidential; Mariana demonstrates Public / On-premises followed by Internal / On-premises.

## Synthetic services and evidence

The catalog contains 18 fictional governed services: six named-environment exchanges, three partner-network services, five enterprise office/research services, and four factory operations services. The latter 12 carry business scope; region is represented by execution environment instead. Weather, sales, and `public_send` remain generic demo tools. Tool results are synthetic. Result metadata is self-declared, fictional, and not independently attested.

Administrator lists named regions under Execution environments and groups business boundaries by Partner network and Enterprise organization. Compliance can filter actual signed ledger records by environment and pre-release outcome, inspect transition provenance, and distinguish released from withheld tool results.

Participant credentials are signed by the demo authority; they are not external provider attestations. The signed hash chain is tamper-evident append-only application storage, not immutable storage. Provider acceptance and SDK hooks do not prove participant behavior outside the enforced demo path.

## Validation and limits

```powershell
npm test
```

The bounded demo supports 200 chats, 20,000 ledger records, 40 messages per chat, one active turn, and at most two SDK attempts for one protection-driven restart. Tests use temporary state outside the repository.

Stop the demo with:

```powershell
.\stopdemo.ps1
```
