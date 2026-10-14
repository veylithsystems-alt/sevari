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
