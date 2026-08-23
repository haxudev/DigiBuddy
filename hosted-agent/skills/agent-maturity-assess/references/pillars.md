# Pillar reference — Microsoft Agentic AI adoption maturity model

Grounding source for every dimension and anchor in `question-bank.json`. All five
pages retrieved **2026-08-21**.

Model root: <https://learn.microsoft.com/en-us/agents/adoption-maturity-model/>

## Levels

| Level | Name | One-line meaning |
| --- | --- | --- |
| 100 | Initial | Unplanned and experimental; depends on individuals, not practices |
| 200 | Repeatable | Early patterns emerge; informal and uneven across the organization |
| 300 | Defined | Formally defined, documented, governed; aligned to business goals |
| 400 | Capable | Embedded in enterprise planning and operations; scales across teams |
| 500 | Efficient | Agent-first enterprise; optimized and continuously improved |

Microsoft says each capability pillar is assessed across these five levels and
allows different domains or platforms to mature at different speeds. It does
not publish one organization-wide score. This project's conservative floors,
means and evidence gates are documented separately in `scoring-rubric.md`.

## Responsible AI handling

Learn states RAI is "embedded across all dimensions" and writes an explicit
Responsible AI clause into each level descriptor of pillars A, C and E, with
equivalent trust/oversight content in B and D. RAI is therefore **not a sixth
axis**. Each pillar designates exactly one **RAI-bearing sub-dimension** whose
anchors carry that pillar's Responsible AI characteristic at each level. The
report renders those five values as an axis-aligned blue overlay; it must not
collapse them into a circle that loses the pillar-specific information.

---

## Pillar A — AI strategy and experience

- **Source:** <https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-strategy>
- **Retrieved:** 2026-08-21
- **Learn structures each level as three blocks:** *AI strategy*, *Experience*, *Responsible AI*.

### Sub-dimensions

| id | Name | Derived from |
| --- | --- | --- |
| `A1` | Vision and executive sponsorship | "AI strategy" block: vision articulation, executive leadership, agent-first definition — **RAI-bearing** (the Responsible AI block at every level is about leadership positioning RAI as a strategic pillar) |
| `A2` | Strategy-to-planning integration and key results | "AI strategy" block: alignment with enterprise/IT planning, budgeting, architecture standards, objectives and key results |
| `A3` | User experience and adoption design | "Experience" block: discovery, consistency across agents, personalization, human-agent handoff |

### Level descriptors

| Level | AI strategy | Experience | Responsible AI |
| --- | --- | --- | --- |
| 100 | No AI or agent strategy; siloed experimentation; no link between AI initiatives and business goals; business and IT operate independently; no executive leadership | Unplanned experiences with significant friction; users struggle to find or use agents | No awareness of Responsible AI principles or risks |
| 200 | Emerging vision articulated but sitting outside core enterprise and IT strategy; informal and inconsistently communicated; agents explored in isolated scenarios | Basic experiences with usability issues; value found but friction and inconsistency; early patterns not systematized | Basic awareness exists but is not integrated into strategy |
| 300 | Formal documented strategy aligned to business objectives; explicit leadership sponsorship; roadmap across functions; OKRs exist but execution varies; alignment with enterprise planning still maturing | Users can discover and use agents relevant to their work; consistent branding and interaction patterns | RAI principles integrated into strategic planning and decision-making |
| 400 | Enterprise and IT strategy fully aligned around an agent-first operating model; strategy embedded in enterprise planning; business-unit sub-plans ladder up, often via a CoE; leadership actively sponsors and reviews outcomes | Sophisticated experiences adapting to individual needs; seamless access to multiple agents through unified interfaces | RAI positioned as a strategic advantage and integrated into all strategic communications |
| 500 | Agent-first organization with a living, adaptive strategy; C-suite accountability; leadership at all levels reinforces the vision; strategy continually refreshed from telemetry and external signals | Users interact with agents as naturally as with colleagues; experiences self-improve from usage patterns | RAI deeply embedded in culture and seen as a fundamental business value |

### Anti-patterns by level

100 technology-first thinking · 200 strategy documentation theater · 300
experience inconsistency across agents · 400 strategy bureaucracy · 500
complacent excellence.

---

## Pillar B — Business strategy (process transformation and value)

- **Source:** <https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-business-process>
- **Retrieved:** 2026-08-21
- **Learn structures each level as two blocks:** *Process excellence*, *Value realization*.

### Sub-dimensions

| id | Name | Derived from |
| --- | --- | --- |
| `B1` | End-to-end process redesign | "Process excellence": task assistance → agents executing and orchestrating multistep, cross-system workflows |
| `B2` | Human-agent decision rights and oversight | "Process excellence": explicit decision rights, humans in control, autonomy raised only where processes and governance are mature — **RAI-bearing** (trust, oversight and risk indicators) |
| `B3` | Value measurement and portfolio decisions | "Value realization": baselines, standardized KPIs, dashboards, scale/refine/retire decisions |

### Level descriptors

| Level | Process excellence | Value realization |
| --- | --- | --- |
| 100 | Manual human-led processes, no workflow redesign; agents assist but do not change core workflows; agents do not trigger systems or coordinate tasks | No formal tracking of outcomes; success described anecdotally; no baselines or success criteria; no linkage to business outcomes |
| 200 | Agents support some steps of a task; incremental improvements; small redesigns without coordinated end-to-end transformation | Early qualitative value recognition; some metrics defined but inconsistent; ROI varies by team; value assessed after delivery; not tied to enterprise KPIs or OKRs |
| 300 | End-to-end workflows redesigned so agents participate in execution, not just assistance; human-agent roles documented; redesigned processes tracked against measurable outcomes | Agents have defined KPIs and success metrics; benefits tracked per project; business cases include expected ROI; insights remain siloed by domain |
| 400 | Agents orchestrate multistep cross-system workflows; human-led agent-operated processes standard in key functions; business units propose transformation; predictive insights embedded | Regular value reporting to leadership; proven ROI across multiple agents; value embedded in governance and portfolio reviews; under-performing agents redesigned or retired |
| 500 | Core processes agent-operated, adaptive and data-driven; high autonomy with sophisticated human oversight; agents enable new operating models; transformation embedded in culture and performance management | Real-time enterprise-wide view of AI value; scale/modify/retire decisions fully data-driven; metrics span outcomes, experience and trust/risk; quantitative impact storytelling is leadership culture |

### Anti-patterns by level

100 technology before process · 200 task automation mindset · 300 process
perfectionism · 400 value measurement bureaucracy · 500 optimization tunnel vision.

---

## Pillar C — AI governance and security

- **Source:** <https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-security-governance>
- **Retrieved:** 2026-08-21
- **Learn structures each level as three blocks:** *Governance and security*, *Operations and lifecycle*, *Responsible AI*.

### Sub-dimensions

| id | Name | Derived from |
| --- | --- | --- |
| `C1` | Governance framework and agent classification | "Governance and security": ownership, decision rights, tiering by purpose/criticality/autonomy, registry, AI Council — **RAI-bearing** (RAI standards, impact assessments, lifecycle gates) |
| `C2` | Security, identity and data boundaries | "Governance and security": identity and access, data policy and connector governance as an agent safety boundary, environment separation, audit logging |
| `C3` | Operations and lifecycle management | "Operations and lifecycle": monitoring, SLAs differentiated by criticality, incident response, continuous improvement, retirement |

### Level descriptors

| Level | Governance and security | Operations and lifecycle | Responsible AI |
| --- | --- | --- | --- |
| 100 | No AI-specific governance or security standards; agents operate without oversight, risk assessment or compliance checks; all agents treated the same; no formal environments, data policies or approval checkpoints; no clarity on ownership | No formal operational support; agents run without monitoring, ownership or improvement; problems discovered informally | No formal RAI awareness or practices |
| 200 | Basic tenant-level controls documented but inconsistently applied; some approval steps such as security review before production; some dev/test/prod separation; early personal-vs-shared distinction with manual controls; governance reactive | Basic monitoring from out-of-the-box reports; support reactive and dependent on a few individuals; informal runbooks; unclear accountability | Basic risk checklists and manual RAI reviews, inconsistently applied |
| 300 | Practices documented and enforced; audit and monitoring in place; agents classified by purpose, criticality and autonomy; zoned governance model; approval, risk assessment and ALM requirements per agent class; CoE or AI Council begins formal oversight; central registry and audit logging | Formal operations model; agents classified by criticality with differentiated support; SLAs, monitoring and escalation for mission-critical agents; documented incident management; improvement loops emerging | RAI standards documented and communicated; high-risk agents require RAI impact assessments |
| 400 | Risk-based and partially automated governance; cross-functional AI Council actively reviews and monitors; productivity agents move fast with lightweight controls while mission-critical agents follow full ALM/security rigor; federated governance with delegated approvals; continuous monitoring and policy-driven compliance | Proactive, increasingly automated operations; anomaly detection triggering alerts or automated remediation; ongoing performance tuning; regular operational reporting; incident response covers AI-specific risks | RAI embedded by design across all agent initiatives |
| 500 | Agents treated as tiered digital services with differentiated SLAs, controls and autonomy; governance continuously adapts to usage, risk and regulation; predictive risk analytics and continuous compliance; governance accelerates innovation | Predictive and self-optimizing operations; many problems detected and resolved automatically; user feedback deeply integrated; self-healing systems | RAI internalized with visible executive oversight; trust, risk and ethics part of strategic and performance discussions |

### Universal governance failures (apply at any level)

No inventory and no ownership · controls that are guidance-only rather than
enforceable · missing environment strategy · treating all agents the same
instead of tiering by risk and criticality · data policy and connector
governance not treated as an agent safety boundary · audit and monitoring as an
afterthought · security posture not continuously validated · unmanaged cost and
usage governance.

---

## Pillar D — Technology and data

- **Source:** <https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-technology>
- **Retrieved:** 2026-08-21
- **Learn presents one block per level;** the "what high maturity looks like" list names six capability areas, condensed here into three.

### Sub-dimensions

| id | Name | Derived from |
| --- | --- | --- |
| `D1` | Platform and architecture standardization | "Standardized agent architecture and platforms": approved platforms, reference architectures, when to use Agent Builder vs Copilot Studio vs Microsoft Foundry |
| `D2` | Data foundation and grounding | "Secure, governed data and integration access" plus the data-architecture guidance: retrieval strategy, Microsoft 365 for collaboration content and Fabric OneLake for business data, medallion layers, certified datasets |
| `D3` | Lifecycle, reuse and observability | "Managed, automated development lifecycle", "Reusable components", "Built-in observability and evaluation": dev/test/prod separation, source control, CI/CD, approved connectors, shared components, telemetry and automated evaluation — **RAI-bearing** (safety scanning, adversarial testing and continuous posture validation live here) |

### Level descriptors

| Level | State of technology and data |
| --- | --- |
| 100 | Exploratory and fragmented; prompts or lightweight agents with no technology plan; unplanned data access limited to Microsoft 365 documents or direct system calls with no retrieval strategy; no clarity on SaaS vs custom agents; no consistent platform, ALM or integration standards; isolated proofs of concept that are fragile, undocumented and hard to reuse |
| 200 | Converging on a small set of platforms but chosen by team preference rather than use-case fit; data partially prepared — Microsoft 365 content accessible, structured business data still siloed with few approved connectors; basic retrieval or point integrations limiting reliability and reuse; dev/test separation may exist but ALM and telemetry inconsistent; version control used inconsistently |
| 300 | Documented technology plan; consistent distinction between SaaS agents, Copilot Studio agents and advanced build paths; clear data architecture — Microsoft 365 for collaboration content, Fabric OneLake for unified business data, medallion layers enabling grounding in validated sources; standard reference architectures and integration patterns reused; ALM established for production agents; structured design framework used |
| 400 | Enterprise-grade foundations; clear visibility into systems, APIs and data used across workflows; secure-by-design access patterns, centralized telemetry and automated evaluations standard; automated reliable deployments; centralized monitoring across the organization |
| 500 | Foundations continuously evolve from telemetry and emerging agent patterns; workflow data models and integrations maintained as shared enterprise assets; federated teams build independently while guardrails enforce quality by default; architecture supports complex multi-agent scenarios at scale |

### Anti-patterns by level

100 demo-driven experimentation · 200 hero engineering · 300 process over
enablement · 400 stable but slow · 500 complacent maturity.

---

## Pillar E — Organization and culture

- **Source:** <https://learn.microsoft.com/en-us/agents/adoption-maturity-model/maturity-model-readiness>
- **Retrieved:** 2026-08-21
- **Learn structures each level as two blocks:** *Organization and culture*, *Responsible AI*.

### Sub-dimensions

| id | Name | Derived from |
| --- | --- | --- |
| `E1` | AI operating model, roles and ownership | "Organization and culture": decision rights, accountability, intake and escalation, CoE, agent business owner, operations and support lead |
| `E2` | Enablement, skills and learning | "Organization and culture": structured onboarding, learning paths, knowledge repositories, upskilling |
| `E3` | Community, champions and incentives | "Organization and culture": champion networks, showcases, recognition, incentives and performance expectations, adoption and sentiment measurement — **RAI-bearing** (employees demonstrating RAI habits, ethical reasoning, trust and fairness as core values) |

### Level descriptors

| Level | Organization and culture | Responsible AI |
| --- | --- | --- |
| 100 | Adoption exists only in isolated experiments; no shared enterprise narrative; leadership sponsorship weak or absent; agents seen as a technical or optional activity with no clear ownership for adoption, value or risk; employees lack clarity and learning is informal and self-directed | No awareness of RAI principles or ethical considerations in daily practice |
| 200 | Interest growing but adoption depends on motivated individuals; training and communities sporadic without a structured program or operating model; decision rights and ownership unclear, causing inconsistent practices and friction | Basic RAI awareness exists but is not consistently applied or reinforced |
| 300 | Documented organizational approach; a central team or CoE provides standards and enablement while execution is federated; structured onboarding, learning paths and community events; knowledge repositories and regular showcases; leadership endorsement present but uneven | RAI principles formally documented and communicated; champions recognized and trained on RAI practices |
| 400 | Agent-assisted work standard across functions; incentives and performance expectations reinforce responsible agent use; culture supports experimentation within clear ethical guardrails; business units propose agent-enabled improvements; communities active and self-driven with regular showcases and hackathons | Leaders consistently model AI-first behaviors and RAI decision-making; RAI practices embedded in daily workflows |
| 500 | Agent-first enterprise; grassroots ideas rapidly surfaced, governed and scaled with embedded ethical considerations; culture, leadership, incentives and learning fully aligned; communities reinforce standards and innovation | RAI deeply embedded in culture and seen as a core competitive advantage; all employees demonstrate mature RAI habits and ethical reasoning |

### Anti-patterns by level

100 technology project mentality · 200 champion dependency · 300 standards
isolation (a CoE detached from practitioners) · 400 innovation fragmentation ·
500 cultural complacency.

### Roles Learn names for agentic adoption

Executive sponsor · agent business owner (per domain or use case) · agentic
Center of Excellence · platform and IT leads · security, risk and compliance
partners · operations and support lead · champions and community leads.
