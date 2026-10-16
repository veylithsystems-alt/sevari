# The original vision (Synchronicity v1.0, Operion Sevari v1.0) mapped to the build contract

Sources (April 2026): *Synchronicity — Full System Architecture, Schema & Deployment Guide v1.0*; *Operion Sevari Design Brief v1.0*; earlier *Sevari Product Brief*, *Design Brief v2.2*, *Architecture v2.3*; the n8n builds v3.6 / v4.1.

**Rule (Dan, 14 Oct 2026): do not deviate from the build contract.** This file records what the original vision means for the build: what's already covered, what the core must be shaped to allow later, and where the vision and the contract disagree. Disagreements are questions for Dan (`docs/QUESTIONS_FOR_DAN.md`), never silent changes.

## 1. The vision in one paragraph

One platform, two modes. **Enquiry Mode** ("Serenity DNA") answers every inbound enquiry reliably, for individuals and businesses. **Agent Mode** ("Sevari DNA") adds seven specialist agents that augment a business team: BASTION (support), SENTINEL (monitoring), HERALD (content), VANGUARD (sales), COMPASS (market intelligence), LEDGER (finance), FORGE (code). It runs on two UK VPSs with local models. It promises a fixed price with no revenue share, a failsafe chain that ends in templates and a human, an immutable audit, owner approval from the phone, a HIVE learning layer that only changes things with Dan's approval, and a planned path to Temporal and to GPUs.

## 2. Already covered by the contract (no change needed)

| Vision | Contract | Status in build |
|---|---|---|
| "Every enquiry completes"; templates need zero AI; human escalation last | §5.2 deterministic ACK off the inference path; §5.3 templates default; §5.4 UNKNOWN; §36.2 degradation ladder | ACK in Phase 4 |
| "Every decision has a receipt": immutable chain-hashed audit | INV-8 | **Done and stronger**: the database computes the hash over the whole row; signed checkpoints (Phase 1) |
| Separate audit database, app has INSERT/SELECT only | INV-8 (table-level) | Same guarantee via grants plus a trigger that refuses UPDATE/DELETE for every role (§4 below) |
| Tenant isolation absolute | INV-1 | **Done**: RLS forced, composite tenant keys |
| PII encrypted with AES-256-GCM | §6.3 | **Done and stronger**: per-tenant envelope keys, context binding, crypto-shred |
| Humans approve what matters; financial always approved, no timeout | §7, §8.3, §19.2 | Phase 6 |
| Dan-only approval for system-level changes; no self-applying learning | §31 human gate, INV-17–19 | Phase 20–21 |
| Operating modes Assist → Co-pilot → Autonomous (Dan-enabled) | §7.2 graduated autonomy (earned per action class; grants need a human) | Phase 6 |
| Swipe-to-approve on the phone | §7.1 approvals, owner UI | Phase 6, hardened (single-use, expiry, digest; defect D-11, D-12) |
| Morning brief 07:00 / evening summary 19:00 | §8.1 weekly owner report and digests; §46 pilot report | Phase 8 (briefs as owner-facing reports) |
| Temporal migration markers per zone | ADR-0002 workflow port shaped for Temporal | Port defined; per-workflow `engine` marker planned |
| GPU upgrade path pre-seeded (`gpu_config`) | §9 model registry ("the GPU path is a registry entry") | Phase 5 |
| Selftest, all checks pass before go-live | INV-9 boot guard; §63 Production Readiness | **Done** (boot guard); PR phase defined |
| Tier gating: higher-tier features visible but locked | §47 pricing as data | Plans and entitlements as data (Phase 13) |
| GDPR erasure, export, SAR from the dashboard | §21, Phase 7 | Phase 7 |
| UK data residency | §5.1 sovereign cells, INV-2, INV-3 | **Done** (region rules); egress in Phase 2 |

## 3. Shaping the core so Agent Mode can come later without a rewrite

The contract builds Enquiry Mode and the business lifecycle first. The vision's Agent Mode is the obvious next horizon. Without deviating from the contract, the core is being shaped so that an agent becomes **a pack plus action classes, not a core change** (§1 "config and data, not code"):

1. **Tasks are a kind of inbound item.** The intake model treats "enquiry from a customer" and "task from the owner" as two kinds of the same envelope (`kind`, optional `target`). Only enquiries are processed until an agent pack exists.
2. **Agents are workflow packs** on the lifecycle and workflow engine (§16, §36.1, ADR-0002): each pack declares its prompts, allowed tools (as egress-declared adapters), action classes, schedules and eval suite, and is signed and versioned.
3. **Gate levels map onto the autonomy engine.** *Auto-approve* = classes that are automatic by policy (like `ack`). *Require-approval* = approval class. *Queue-and-notify* has no equivalent (see conflict C-1).
4. **New action classes for agents** (`content_publish`, `outreach_send`, `code_change`, `report_publish`...) need a contract amendment (§7.2). The autonomy engine reads classes from a typed registry, so adding one is a registry entry plus its tests, not new engine code.
5. **Scheduled agents** (HERALD 06:00, COMPASS 05:00, LEDGER Mon 03:00, SENTINEL hourly) are durable timers on the workflow port.
6. **Model routing per agent** (phi3 for precision, a coder model for FORGE) is a model-registry selection rule by task type (§9), not hard-coded tiers.

## 4. Ideas worth adopting inside the contract

| Idea from the vision | How it fits | When |
|---|---|---|
| **Separate audit trust boundary** (own database) | Put the audit tables in their own schema owned by a dedicated role, so even the migration role can't alter them. Matches §67's "separate trust boundary" thinking | Phase 7 hardening (proposal R-19) |
| **Selftest endpoint** with named checks | Expose the boot report (INV-9) as an authenticated `/health/selftest` for the operator and the readiness pack (§63) | Phase 2 API |
| **Companies House pre-fill at onboarding** | The owner enters their company number; the system pre-fills draft knowledge records (name, registered address, SIC) **for the owner to confirm** (§18 I5). Companies House's public API is a processor/ADR item. This automates a real chore lawfully | Phase 11 (needs an ADR; proposal R-20) |
| **Evidence-linked briefs** | Each line of a brief links to the audit events behind it | Phase 8 |
| **Visible, honest tier gating** | Locked features shown with the plan that unlocks them; no dark patterns | Phase 13 |
| **SMS "APPROVE <token>" replies** | Fine for low-risk classes if the token is single-use, expiring and digest-bound and the sender number matches. For consequential classes, the passkey step in R-12 still applies | Phase 6 |

## 5. Where the vision and the contract disagree (contract wins; Dan decides)

**Decided 14 Oct 2026:** Agent Mode is now in the contract (Part K). C-1: silence never approves, but the customer is always auto-acknowledged and every human input is acknowledged and acted on (§74). C-2: disclose AI where required. C-11: the name is **Sevari**. The rest stay open.

| # | Vision says | Contract says | Why it matters |
|---|---|---|---|
| C-1 | **Queue-and-notify**: deliver anyway if the owner doesn't respond within 2 hours | INV-14: silence never approves; timeouts go to a declared safe state | A customer could get an unapproved AI reply. The contract's route to the same convenience is an **earned autonomy grant** per action class (§7.2), measured, revocable and opted into |
| C-2 | End customers never see AI mentioned; the response guard strips "AI" from replies | §8.4: AI-drafted content is disclosed where the tenant's policy or law requires | Stripping disclosure can breach transparency rules (counsel to confirm per region). Replies still come in the business's own name |
| C-3 | White label never exists at any tier | §36.1: agency and white-label tenancy (parent managing children) | Product decision |
| C-4 | Retention by price tier (Starter 90 days ... Enterprise custom) | §6.4 / §19.6: retention by purpose and law, per data category | Retention can't depend on what someone pays. Plans can offer *longer optional archives* within the lawful maximum |
| C-5 | COMPASS web scraping; HERALD researches online; EKP Google Places lookups | §17.1 Tier E disabled; terms-of-use checks; claims register (§43) | Needs its own contract part and ADRs |
| C-6 | FORGE writes and deploys code to GitHub | Not in the contract | A different product with a different risk profile |
| C-7 | HIVE trains on Sevari operations, then Serenity launches "pre-trained" | §31.4: cross-tenant learning only aggregated, k-anonymous, with contract terms and a DPIA | Learning across products and tenants must follow §31–§35 |
| C-8 | "GDPR, UK GDPR, CCPA, PIPEDA, LGPD covered by the architecture" | §29 / §43: no claim without evidence; counsel confirms per region | These are unverified claims and must not be published until counsel confirms each one |
| C-9 | PII key derived via SHA-256 from an environment variable | §6.3 envelope encryption; §67 key boundary | Already superseded by the stronger design |
| C-10 | Pricing £79–£399 (Operion) or £149–£1,299 (Synchronicity) inc VAT | Part E: £59 founding rate ex VAT; pricing as data | Three price lists exist (Q-2) |
| C-11 | Product names: Synchronicity, Serenity, Operion, Sevari | Contract: "Sevari BDI" | Brand decision (Q-9) |
| C-12 | Hosting: IONOS UK, two VPSs; Ollama over plain HTTP on the private network | §26/§69 processor registry; §60.1 egress; §67 key boundary | IONOS goes in the processor registry with an ADR; VPS-to-VPS inference traffic should be encrypted (WireGuard or TLS) |

## 6. One correction to the vision's legal text

The brief says "UK adequacy decision provides data flow to EU". Data protection adequacy runs the other way: the EU's adequacy decision for the UK lets **EU→UK** transfers flow, and UK rules separately permit **UK→EEA** transfers. Counsel should confirm the current position before any document states it. This is an example of why §43's claims register exists.

## 7. Second review (14 Oct 2026): Product Brief, Design Brief v2.2 and Synchronicity v1.0 against contract v1.11

Dan asked: are the vision and the contract aligned, can the vision come true, and what could still improve?

### 7.1 Verdict
- **The heart is aligned.** Every promise that makes Sevari different is in the contract and most are already built and tested: every enquiry gets an answer even if the AI is down (deterministic ACK, templates, human), nothing consequential goes out without approval, a tamper-evident record, private local AI with no cloud AI, each business sealed off from the others and encrypted with its own key, money always needs a human, honest "I don't know" instead of guessing, export and erasure, and learning that only changes things with approval.
- **The contract is stricter than the vision in a handful of places**, on purpose (C-1 to C-12 above, and C-13 to C-20 below). In each case the vision's *promise* survives; what changes is the mechanism or the wording, so that it is true, lawful and provable.
- **The vision is achievable, in order.** Enquiry Mode for small UK service businesses on private CPU inference is technically realistic and is what Phases 0–8 deliver. The parts that are hard are commercial (getting pilots, proving owners save time and money, keeping support load manageable for a one-person company), not technical. Agent Mode is achievable as plug-in packs (Part K) once approvals exist; FORGE (code agent) is the one piece that can't be market-leading on a 7B model on a CPU.

### 7.2 New differences found in this review

| # | Vision says | Contract says | Why it matters / recommendation |
|---|---|---|---|
| C-13 | Self-serve: "ten questions, ten minutes, first enquiry handled in under an hour, no setup calls" | §18: owner-confirmed knowledge, shadow mode, and **activation is a human decision** (§8.3); T-ONB-1 and T-ONB-3 | Both can hold: the owner's own "go live" tap after an automatic checklist is the human approval for **Assist mode** (every reply waits for their tap; the customer ACK is deterministic). Shadow mode becomes a recommended option, not a wait. Dan's approval stays for regulated trades and anything beyond Assist. **Question Q-15** |
| C-14 | For anyone: mobile hairdresser, childminder, IT support engineer, garden clearance, the kitchen-table founder | Part D beachhead: five unregulated trades (drainage, roofing, locksmiths, garage doors, landscaping) | Not a conflict: packs are data, so new audiences are new packs. Childminding involves children's data and Ofsted registration, so it would be `regulated: true` and needs counsel. **Question Q-16** |
| C-15 | If the owner doesn't respond, the request escalates to a **delegate** they trust, and the reply still gets sent | Silence never approves (INV-14, §74). No delegate concept | Delegates fit the contract if the delegate **actively approves** (never a timeout approval): owner names people and what they may approve; unanswered requests move to them after a delay the owner sets; everything is acknowledged (§74). Money stays owner-only unless the owner grants it explicitly. **Question Q-17** |
| C-16 | Several promises are worded as absolutes | §43 claims register: no claim without evidence | Reword before any public page (table 7.3). This protects Dan legally and is still a strong pitch |
| C-17 | Approvals by SMS ("one tap on your phone") | §7.1 approvals; §36.1 owner app (PWA) | Approval texts cost money on every enquiry (Part G). Recommendation: approvals in the owner app with free push notifications first, SMS only as a fallback when push isn't answered or the owner prefers it. Same one-tap experience, lower cost. Proposal R-21 |
| C-18 | "Talk to Sevari herself on the website" | Not stated; `tenants.is_house` exists | Veylith as **tenant zero**: Sevari answers Veylith's own sales enquiries through the same pipeline, with the same rules. The best possible demo, and it finds problems before customers do. Proposal R-22 |
| C-19 | HERALD phases switched by running SQL by hand (`UPDATE marketing_phase …`) | Part K: agents are signed packs; changes are data with approval records | Becomes a setting in the owner/operator console with an approval record. No hand-written SQL in production (already how the build works) |
| C-20 | FORGE (code agent) in the Enterprise plan | Part K6 | A 7B model on a CPU can't compete with dedicated coding tools, and code deployment is a very different risk. **Question Q-18** |

### 7.3 Promises that need rewording (for the claims register, §43)

| Brief says | Problem | True and still strong |
|---|---|---|
| "Encrypted with a key only your business has" | The key is unique to the business but held by Sevari's key service, so Veylith's systems can use it | "Encrypted with your business's own key. Delete your account and that key is destroyed, so the data can never be read again." |
| "Logged permanently… prove what was said indefinitely, verbatim" | Message content is personal data and can't be kept forever; customers can ask for erasure | "Every decision is recorded in a tamper-evident log. Message content is kept for [period counsel confirms], and the record of what happened is kept for as long as the law allows." |
| "Can't be told to skip the rules… not by us" | Veylith writes the code and could change it | "The rules are built into the system and tested on every change. No setting, customer message or AI suggestion can switch them off, and any change to them is a recorded, reviewed decision." |
| "Cannot fail" / "That's a guarantee" (T5 templates) | Nothing on a server is impossible to fail; a guarantee creates legal liability | "Every enquiry gets a reply even if the AI is down. Replies don't depend on the AI." Publish measured uptime instead |
| "Same input, same output. Proven." | True for the rules engine; model wording can vary slightly | "Decisions are made by fixed rules: the same message gets the same decision, and we can replay any past reply." |
| "No cloud AI. Ever." alongside the desktop GPU over Cloudflare Tunnel | The tunnel makes Cloudflare a processor of customer content (Q-3) | Keep the promise; drop or rework the tunnel (Q-3) |
| "All prices include VAT" | Only true if Veylith is VAT-registered; below the threshold no VAT can be charged | Show prices "VAT included where applicable" until registration is confirmed (counsel/accountant) |
| "Incorporation triggered by the first Stripe payment" | The contracting party, DPA, ICO fee and Twilio bundle all depend on the entity, and must be settled before the first customer's data is processed | Decide the entity before the first pilot (Q-4) |
| "Digital content activation waiver" refund policy | Most customers are businesses, not consumers, so consumer cancellation rules may not apply; sole traders acting for their business usually aren't consumers | Counsel drafts the terms (PR-8) |
| "GDPR, CCPA, PIPEDA, LGPD covered" | Unverified (C-8) | Name only what counsel has confirmed |

### 7.4 Decided by Dan, 14 Oct 2026 (contract v1.12, Part L)
- C-13: fast but safe go-live (§81). C-14: any service business, with a pack builder; Sevari finds its own audience within the law, D3 unchanged (§83). C-15: two authority scopes, Dan for product and build exceptions, the business owner for their own (§82). C-20: FORGE deferred (§84). C-16: claims wording into the register (§85).
