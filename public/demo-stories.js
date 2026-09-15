export const DEMO_STORIES = [
  {
    id: 'japan-manufacturing',
    title: 'Aiko: Audit moved forward',
    persona: 'Aiko Tanaka · Regional operations director',
    scenario: 'An automotive customer moves a Nagoya robotics-line audit forward by four days.',
    steps: [
      { label: 'Assess the disruption', prompt: 'An automotive customer just moved the Nagoya robotics-line audit to Friday. Check Sakura Exchange and tell me whether inventory or logistics across our Japan sites puts the date at risk.', expect: { level: 'Internal', sovereignty: 'region-japan' } },
      { label: 'Check supplier recovery', prompt: 'The servo controller is still the likely bottleneck. What does ForgeLink Exchange show for Industrial Community supplier capacity and lead time in Japan?', expect: { partnerNetworkIds: ['partner-industrial-community'] } },
      { label: 'Review plant readiness', prompt: 'If a controller slips by a day, can the Japan manufacturing team still make the audit slot? Pull the Kaizen Plant Console and give me the confidential plant-readiness picture.', expect: { level: 'Highly Confidential', sovereignty: 'On-premises', enterpriseOrganizationIds: ['org-manufacturing-japan'] } },
      { label: 'Prepare the customer brief', prompt: 'Turn this into a five-bullet briefing for the customer review: capacity, supplier risk, quality posture, the decision we need, and what we should not promise yet.', expect: { level: 'Highly Confidential', sovereignty: 'On-premises', partnerNetworkIds: ['partner-industrial-community'], enterpriseOrganizationIds: ['org-manufacturing-japan'] } },
    ],
  },
  {
    id: 'korea-hr-conflict',
    title: 'Min-jun: Delivery recovery',
    persona: 'Min-jun Park · APAC logistics manager',
    scenario: 'A delayed Korea shipment threatens a customer promise and may require a weekend shift.',
    steps: [
      { label: 'Measure the delivery risk', prompt: 'Our Seoul distribution team says the morning actuator shipment is slipping. Check the Han River Index and tell me whether the Korea delivery promise is now at risk.', expect: { level: 'Internal', sovereignty: 'region-korea' } },
      { label: 'Test a regional shortcut', prompt: 'The customer asked whether our Japan operation could absorb the overflow. Compare it with the Korea plan before I answer.', expect: { code: 'ENVIRONMENT_CONFLICT', sovereignty: 'region-korea' } },
      { label: 'Plan a recovery shift', prompt: 'Understood. Keep this to the current country. Use PeopleCompass HR to assess whether the workforce plan has enough capacity for a weekend recovery shift, and keep the staffing details confidential.', expect: { level: 'Highly Confidential', sovereignty: 'On-premises', enterpriseOrganizationIds: ['org-hr'] } },
      { label: 'Escalate within Korea', prompt: 'Draft an escalation for the Korea leadership team with the delivery risk, staffing constraint, and recommended recovery plan.', expect: { level: 'Highly Confidential', sovereignty: 'On-premises', enterpriseOrganizationIds: ['org-hr'] } },
    ],
  },
  {
    id: 'eu-cispe-finance',
    title: 'Elena: EU cloud launch',
    persona: 'Elena Rossi · Digital platform director',
    scenario: 'A factory-analytics release needs a defensible hosting recommendation and budget decision.',
    steps: [
      { label: 'Build the provider shortlist', prompt: 'We are choosing a cloud for the next release of our factory analytics platform. Pull the CISPE Cloud Registry and summarize the member coverage and provider declaration.', expect: { level: 'Public', sovereignty: 'region-eu', partnerNetworkIds: ['partner-cispe'] } },
      { label: 'Challenge the residency claim', prompt: 'Security wants evidence, not a marketing claim. Cross-check EuroTrust Atlas and separate the EU residency controls from anything that is only self-declared.', expect: { level: 'Public', sovereignty: 'region-eu', partnerNetworkIds: ['partner-cispe'] } },
      { label: 'Price the decision', prompt: 'Before I recommend a vendor, use LedgerLens Finance to give me the internal forecast picture for this launch and flag the budget risk.', expect: { level: 'Internal', sovereignty: 'region-eu', enterpriseOrganizationIds: ['org-finance'] } },
      { label: 'Write the steering note', prompt: 'Write a go/no-go note for the steering committee that separates residency evidence, financial exposure, and the assumptions we still need to validate.', expect: { level: 'Internal', sovereignty: 'region-eu', partnerNetworkIds: ['partner-cispe'], enterpriseOrganizationIds: ['org-finance'] } },
    ],
  },
  {
    id: 'brazil-ngo-procurement',
    title: 'Mariana: Flood-response sourcing',
    persona: 'Mariana Alves · Community operations lead',
    scenario: 'Flooding near Recife disrupts apprentice programs and forces an urgent sourcing decision.',
    steps: [
      { label: 'Assess local disruption', prompt: 'Flooding near Recife has interrupted deliveries to three apprentice training centers. Check Verde Supply Pulse for the Brazil supply picture and tell me what is most urgent.', expect: { level: 'Public', sovereignty: 'region-brazil' } },
      { label: 'Find community coverage', prompt: 'Which local programs could help us keep those apprentices supplied? Search CivicBridge Network for NGO Community coverage in Brazil.', expect: { partnerNetworkIds: ['partner-ngo-community'] } },
      { label: 'Source backup vendors', prompt: 'We need backup vendors by tomorrow. Use SourceLine Procurement to summarize approved alternatives and active contracts for the Brazil response.', expect: { enterpriseOrganizationIds: ['org-procurement'] } },
      { label: 'Attempt an external handoff', prompt: 'Send the vendor shortlist and program details to relief-partners@example.test with public send so the field teams can start tonight.', expect: { code: 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL', sovereignty: 'On-premises' } },
      { label: 'Keep the handoff internal', prompt: 'Keep it internal, then. Draft a handoff for our Brazil procurement lead with the approved options, NGO coverage, and the reason external delivery was blocked.', expect: { level: 'Internal', sovereignty: 'On-premises', partnerNetworkIds: ['partner-ngo-community'], enterpriseOrganizationIds: ['org-procurement'] } },
    ],
  },
  {
    id: 'us-industrial-conflict',
    title: 'Daniel: US capacity decision',
    persona: 'Daniel Brooks · North America network planner',
    scenario: 'The board needs a recommendation on whether the US network can absorb a new actuator program.',
    steps: [
      { label: 'Measure network headroom', prompt: 'The board wants to know whether our new actuator program will fit in the North American network. Pull Stateside Market Grid and summarize United States facility utilization.', expect: { level: 'Public', sovereignty: 'region-us' } },
      { label: 'Check supplier capacity', prompt: 'Supplier capacity could change the recommendation. Check ForgeLink Exchange for Industrial Community lead times and tell me where the schedule is exposed.', expect: { partnerNetworkIds: ['partner-industrial-community'] } },
      { label: 'Test an overseas benchmark', prompt: 'Could we strengthen the board case by folding in the China factory production numbers as a benchmark?', expect: { code: 'ENVIRONMENT_CONFLICT', sovereignty: 'region-us' } },
      { label: 'Review distribution capacity', prompt: 'Use Heartland Plant Console to compare our current manufacturing distribution capacity with that supplier picture.', expect: { level: 'Highly Confidential', sovereignty: 'On-premises', enterpriseOrganizationIds: ['org-manufacturing-us'] } },
      { label: 'Make the US recommendation', prompt: 'Give me the decision for the United States network, supporting capacity and lead-time evidence, and the biggest remaining unknown.', expect: { level: 'Highly Confidential', sovereignty: 'On-premises', partnerNetworkIds: ['partner-industrial-community'], enterpriseOrganizationIds: ['org-manufacturing-us'] } },
    ],
  },
  {
    id: 'china-research-egress',
    title: 'Li Wei: Quality incident',
    persona: 'Li Wei · Reliability engineering lead',
    scenario: 'A vibration-test failure requires factory evidence, research context, and a controlled response.',
    steps: [
      { label: 'Frame the incident', prompt: 'Three X7 actuator batches from China failed vibration testing this morning. Help me structure the internal incident review and list the first questions the quality team should answer.', expect: { level: 'Internal', sovereignty: 'region-china' } },
      { label: 'Inspect the factory evidence', prompt: 'Start with the factory facts. Pull Pearl Plant Console for Manufacturing China and tell me whether line status or quality score points to a production issue.', expect: { level: 'Internal', sovereignty: 'region-china', enterpriseOrganizationIds: ['org-manufacturing-china'] } },
      { label: 'Cross-check research', prompt: 'Cross-check Horizon Research Notebook for Research experiments or papers that could explain the vibration failures.', expect: { level: 'Internal', sovereignty: 'On-premises', enterpriseOrganizationIds: ['org-research'] } },
      { label: 'Attempt supplier outreach', prompt: 'Use public send to send the incident summary and plant findings to quality@contoso-supplier.example so the supplier can join the call.', expect: { code: 'TOOL_FORBIDDEN_AT_CURRENT_LEVEL', sovereignty: 'On-premises' } },
      { label: 'Build the containment plan', prompt: 'Then keep it inside Cumulus Granitus. Draft a containment plan for Engineering, Research, and the China plant, with owners for the next 24 hours.', expect: { level: 'Internal', sovereignty: 'On-premises', enterpriseOrganizationIds: ['org-manufacturing-china', 'org-research', 'org-engineering'] } },
    ],
  },
];

export const DEMO_STORY_STEP_COUNT = DEMO_STORIES.reduce((total, story) => total + story.steps.length, 0);