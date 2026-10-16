# sevari-core — Build Contract for Claude Code

Version 1.13 · 14 October 2026 (Part M: free until revenue, texts for paying customers only, HIVE, integration layer, self-improving knowledge, growth; Part L: vision alignment — fast safe go-live, two authority scopes, any service business and self-sourced audience, FORGE deferred, claims wording; Part K: Agent Mode and acknowledging every human input, binding on Dan's merge; Part J: definition of finished, production readiness, value gate, delivery ambiguity, key management, grounding holdout, processor registry, recovery, legal precision; Part I: Twilio ADR draft answers; Part H: build checklist and Twilio ADR requirements; Part G: capacity and cost-floor model; missed-call text adapter confirmed, Part F; D1 and D3 confirmed; Part D: market, beachhead, trades; Part E: pilot market, pricing and outreach; Appendices 1–2: go-to-market and pilot plans) (Part B: full lifecycle §16–§27; Part C: decisions, human feedback, governed self-learning, platform hardening §28–§40) · Owner: Dan Hadfield (Veylith Systems)
Status: binding on every pull request. If the code and this contract disagree, the code is wrong or the contract needs to be amended (§14). Nothing in between counts.

---

## 0. How to use this contract

1. Read the whole document before you write any code.
2. Read the references in §2. Use them for behaviour only. Don't copy code from them.
3. Work in the phases in §11. Each phase is one PR. For each phase, write the tests first, show them failing in the PR description, then make them pass.
4. Never merge. Dan merges.
5. If a rule here can't be met, stop and write a `DEVIATION` entry (§13). Don't make a quiet workaround.

Key words: **MUST** / **MUST NOT** are absolute. **SHOULD** means you need a written reason to depart from it. **MAY** means it's optional.

---

## 1. Mission and design horizon

Sevari BDI is the operations layer for service businesses. It takes in enquiries on every channel, works out what is true, books work, replies, bills, and keeps records. It automates everything that can lawfully be automated, and it routes everything else to a human with the facts already gathered.

Build it for the product it will become, not the one it starts as:

| Starts as | Must be able to become, without a rewrite |
|---|---|
| 1 region (UK), 1 VPS, 16GB, CPU inference | N regions, each a sovereign cell; GPU pools; hundreds of tenants per cell |
| Email + web form + SMS | + WhatsApp, voice, chat widget, marketplace leads (Checkatrade/Bark-style), API |
| 5 trades | Any vertical through config packs. Regulated verticals are gated (§9) |
| Assist mode (owner approves) | Graduated autonomy per tenant, per action class, earned by measured metrics |
| Local Ollama | Any provider behind one interface (Ollama, vLLM, VSAP gateway), chosen by registry scores |
| Owner = only user | Multi-user tenants, roles, staff calendars, white-label agencies |

The test for any design choice: does adding region #2, channel #4 or vertical #20 need **config and data**, or does it need **code changes to the core**? It should be config and data.

### What "market-outclassing" means, so it can be tested
- **Fastest to respond:** acknowledgement p95 ≤ the F7 target (default 10s), on every channel.
- **Never wrong on facts:** the floor for sent replies containing an unsupported fact is zero.
- **Honest unknowns:** the system escalates instead of guessing, and the escalation rate is measured.
- **Provable sovereignty:** egress, region and processor register are tests, not marketing.
- **Owner time:** owner minutes per enquiry is a headline metric, and it must go down release on release.
- **Evidence:** the 50-script competitive benchmark (§10.4) is reproducible from the repo.

---

## 2. References (read first, don't copy)

- Sevari v2.3 architecture brief
- Sevari BDI v3.6.0 importable n8n build (581 nodes: webhook, postgres, code, twilio, emailSend, httpRequest). It's a **behavioural reference only**. Pull the intake flows, triage categories, message templates and edge cases out of it into `docs/reference/v3.6-behaviours.md`, and make every behaviour you keep a test.
- v3.6 resurrection review (T1–T23)
- Sevari BDI flagship standard; Design v4 (I1–I12, F1–F8)
- Adericel `docs/adr/ADR-0012` and its approval documentation
- VSAP `docs/BUILD_CONTRACT.md` (egress, nftables)
- Sevari contract §5 (human-reserved decisions)

---

## 3. Non-negotiable invariants (the floors)

Each one is enforced by a test that runs in CI. Any regression blocks the merge.

| ID | Invariant | Enforced by |
|---|---|---|
| INV-1 | No cross-tenant read or write, tested as the application DB role | F1, RLS + `FORCE ROW LEVEL SECURITY` |
| INV-2 | No cross-region read or write without a `region_transfer_contract` row | F4 |
| INV-3 | No outbound connection to a host that isn't on `egress.allowlist.yaml` | F2 (static + runtime) |
| INV-4 | No consequential action without a valid approval or an autonomy grant (§7) | F6, F8 |
| INV-5 | No sent message containing an ungrounded fact | F3 |
| INV-6 | Every personal-data column is in the erasure registry | F5 |
| INV-7 | Every row has `tenant_id` (where tenant-scoped) and `region` NOT NULL | F4, schema lint |
| INV-8 | Audit log is append-only and hash-chained; app role has no UPDATE/DELETE | T-AUD |
| INV-9 | The app refuses to start if any of these fail: RLS on, egress policy present, migrations current, KMS reachable, registry checks | T-BOOT |
| INV-10 | No production secret in the repo (gitleaks in CI) | T-SEC |
| INV-11 | Human-reserved decisions (§8.3) cannot be automated by any config value | T-RES |

---

## 4. Stack and repository

- TypeScript (strict), Node 22 LTS, pnpm workspaces, PostgreSQL 16, Fastify, Zod for every boundary, Kysely or Drizzle (typed SQL, raw SQL allowed for RLS), Vitest + Testcontainers, Playwright for the owner UI.
- Queue: Postgres-backed (`graphile-worker` or `pg-boss`). No Redis in v1. Keep the queue behind an interface so it can be swapped later.
- Observability: OpenTelemetry, run through a **local** collector. Exporters only to allowlisted hosts.
- Container: distroless, non-root, read-only filesystem, one image per service.

```
sevari-core/
  apps/
    api/            # intake, owner API, webhooks
    worker/         # jobs: drafting, grounding, sends, retention
    owner-ui/       # approvals inbox, knowledge editor, metrics
  packages/
    domain/         # pure deterministic core (no I/O)
    db/             # schema, migrations, RLS, repositories
    region/         # region context, transfer contracts
    egress/         # allowlisted HTTP client (the only one allowed)
    crypto/         # envelope encryption, per-tenant keys
    channels/       # adapter interface + email, sms, webform
    llm/            # provider interface, registry, prompts, eval
    grounding/      # fact extraction + verification
    approvals/
    autonomy/       # policy engine
    knowledge/      # typed owner knowledge, versioning
    booking/
    billing/
    privacy/        # erasure registry, DSAR, retention, consent
    audit/
    metrics/
    verticals/      # config packs per trade
  config/
    egress.allowlist.yaml
    regions/uk.yaml
  eval/
    corpus/         # 100 synthetic enquiries, 5 trades
    competitive/    # 50 scripts + harness
  docs/
    adr/  reference/  DEVIATIONS.md  PROCESSOR_REGISTER.md (generated)
  ops/
    nftables/  compose/  runbooks/
```

Lint rules (custom ESLint, these fail CI):
- No `fetch`, `http`, `https`, `axios`, `undici` imports outside `packages/egress`.
- No I/O imports inside `packages/domain`.
- No `Date.now()` / `new Date()` outside an injected `Clock`.
- No raw string SQL that touches tenant tables outside `packages/db`.
- No LLM output reaches a channel adapter unless it carries a `GroundedDraft` type. Only `packages/grounding` can construct that type, which is enforced by a branded type.

---

## 5. Architecture

### 5.1 Sovereign cells
Each region is a **cell**: its own Postgres, its own workers, its own inference, its own KMS master key, its own egress allowlist and its own processor register. The only thing shared between cells is a **global control plane**, which holds tenant → home region routing, the billing account id and no personal data. The routing table is the only cross-region dataset, and it has its own erasure-registry entry.

A request arriving at the wrong cell gets a redirect. It's never proxied with its data.

### 5.2 Pipeline (per inbound message)
```
receive → authenticate channel → persist raw (encrypted) → ACK (deterministic, ≤ target)
       → normalise → consent/lawful-basis check → identify contact (dedupe)
       → intent (rules first, model fallback; confidence recorded)
       → extract slots (name, job, postcode, urgency, preferred time)
       → eligibility (service area, service offered, hours)  [deterministic]
       → price / availability / booking proposal             [deterministic]
       → compose facts bundle → model WORDS it → grounding check
       → autonomy policy: auto-send | approval | owner escalation (UNKNOWN)
       → send via channel adapter → audit → reply record (metrics)
```
Each step is an idempotent job, keyed by `(message_id, step)`. A crash at any point resumes without double sends: the outbox pattern, with a unique constraint on `(draft_id, channel_send)`.

### 5.3 Deterministic core, model for wording (I4)
- `packages/domain` decides **what** is said. The model decides only **how**.
- The model gets a facts bundle (JSON) and a style profile. It never gets database access or tools.
- Templates are the **default** for routine intents. Model wording is opt-in per intent, once eval shows it beats the template on owner-edit rate without any grounding failures.
- Intent: rules and keyword classifiers first. The model classifies only when rules abstain. Output must be a constrained enum (JSON schema / grammar), or it's treated as an abstain.

### 5.4 UNKNOWN as a state (I7)
Every reply record holds `facts_used[]`, `facts_missing[]`. If anything the customer asked about can't be established from structured knowledge, an `Unknown` is raised. The policy in `config/tenant` follows Dan's decision #3: `all` or `threshold`. It defaults to `all` until the baseline exists.

---

## 6. Data model essentials

### 6.1 Every table
`id uuid`, `tenant_id uuid NOT NULL` (if tenant-scoped), `region region_code NOT NULL`, `created_at`, `updated_at`, `version`. RLS policies:
```sql
USING (tenant_id = current_setting('app.tenant_id')::uuid
       AND region = current_setting('app.region')::region_code)
```
`ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every table. The app role is `NOBYPASSRLS` and isn't the table owner. Migrations run as a separate owner role. A schema lint test fails any table that's missing the columns or the policy.

### 6.2 Core entities
tenants, users, roles, contacts, consents (purpose, basis, source, timestamp, withdrawal), channels, conversations, messages (ciphertext + digest), enquiries, intents, slots, knowledge_records (typed: service, price, hours, area, policy, FAQ; with `source`, `effective_from`, `effective_to`, `version`), bookings, availability, quotes, invoices, drafts, grounding_results, approvals, autonomy_grants, unknowns, reply_records, audit_events, model_registry, eval_runs, erasure_registry, dsar_requests, retention_jobs, region_transfer_contracts, processors.

### 6.3 Encryption (I12)
Envelope encryption: a per-tenant DEK wrapped by the cell's master KEK (a local KMS — `age`/libsodium with a key file in v1 behind an interface; HSM/Vault later). Message bodies, contact PII and attachments are encrypted at the application layer. Use blind-index HMAC columns for lookups on phone and email. Rotation is a job, and revoking a DEK = crypto-shred (this is part of erasure).

### 6.4 Erasure registry (I9)
`packages/privacy/registry.ts` declares, for every table: `category` (none/contact/special/financial/audit), `lawful_basis`, `retention`, `erasure_action` (delete | anonymise | crypto-shred | retain-legal-hold with reason). Build check: introspect the schema. Any column matching PII heuristics, or tagged `@pii` in a migration comment, without a registry entry fails the build. The DSAR export is generated from the same registry.

---

## 7. Approvals and autonomy

### 7.1 Approvals (I8)
`approvals(id, tenant_id, region, action_class, content_digest sha256, approver_id, created_at, expires_at, consumed_at)`.
Consumption happens in **one statement**:
```sql
UPDATE approvals SET consumed_at = now()
WHERE id=$1 AND consumed_at IS NULL AND expires_at > now()
  AND content_digest = $2
RETURNING id;
```
If no row comes back, the action doesn't happen. The digest covers the canonicalised outbound payload: recipient, channel, body, attachments and amounts.

### 7.2 Graduated autonomy (future-proofing the "automate everything" goal)
Action classes: `ack`, `info_reply`, `quote_reply`, `booking_create`, `booking_change`, `cancel`, `invoice_send`, `payment_request`, `refund`, `review_request`, `marketing`.
A tenant gets an `autonomy_grant` per class only when **all** of these are true:
- The owner opted in explicitly (a recorded, versioned consent screen).
- The class isn't on the reserved list (§8.3).
- Over a rolling window of N ≥ 50 drafts in that class: zero grounding failures, owner edit rate ≤ X%, and zero complaints. X and N are config with defaults, and changing them is a human decision.
- Kill switch: any grounding failure, complaint or anomaly automatically revokes the grant and drops the tenant back to assist mode for that class.
`ack` is deterministic and always automatic. `refund`, `payment_request` above the limit, and anything irreversible always need an approval.

---

## 8. Automation scope

### 8.1 Automate (by default, deterministic)
Intake on all channels, dedupe, consent capture and checks, ACK, triage, slot extraction, eligibility, pricing from records, availability, booking proposals, reminders (with consent), drafting, grounding, low-risk sends under a grant, invoices from completed bookings, payment links via an allowlisted processor, chasing overdue invoices on a schedule the owner set, review requests (opt-in), retention and erasure jobs, DSAR assembly (human sign-off before release), backups and restore tests, health checks, metrics, weekly owner report, model evals, egress drift reports, generating the processor register.

### 8.2 Automate with approval (assist mode until earned)
Quotes outside the price records, booking changes and cancellations, external sends in assist mode, anything with financial exposure under the autonomous limit.

### 8.3 Always human (MUST NOT be automatable by config)
Legal perimeter changes, regulatory interpretation, lawful-basis decisions, new regulated verticals, activating a customer, financial exposure beyond the autonomous limits, irreversible actions, autonomy-boundary changes, evidence deletion, constitutional amendments (Sevari contract §5), releasing a DSAR, responding to a regulator, decisions that produce legal or similarly significant effects on a person (UK GDPR Art. 22 — for example refusing service on profiling grounds), and switching a model or vertical that touches a regulated activity. These are hard-coded in `packages/autonomy/reserved.ts`, with a test (T-RES) proving that no config value can unlock them.

### 8.4 Compliance mechanics the code must provide (counsel confirms the law)
- A lawful basis is recorded per processing purpose. Marketing needs PECR-compliant consent, and the soft opt-in rule is a config that counsel signs off.
- Transparency: the first reply on any channel includes the tenant's privacy notice link, and AI-drafted content is disclosed where the tenant's policy or law requires it.
- No special-category inference. The model's prompt forbids it, and a grounding rule blocks sends that contain health or other special-category references unless they came from the customer's own message.
- Data minimisation: prompts get the facts bundle, not the full history, unless that's needed.
- Records of processing (ROPA) are generated from the registry and the processor register.
- A breach-detection hook raises a 72-hour-clock incident in the owner UI.
- I haven't verified the requirements for each region. Each region's YAML carries a `counsel_signoff` field, and the cell refuses to accept live tenants while it's null.

---

## 9. Verticals, channels, models (extension points)

- **Vertical packs** (`packages/verticals/<trade>`) contain intents, slots, eligibility rules, pricing schema, templates and eval cases. A `regulated: true` flag (for example gas — Gas Safe, electrical, legal, finance, health) blocks activation without a recorded human approval. The first 5 trades should be unregulated, or regulated only in ways that don't affect the conversation.
- **Channel adapters** implement `receive`, `verify`, `send`, `capabilities`, `consentModel`. Each adapter declares its egress hosts. If they aren't on the allowlist, CI fails.
- **LLM providers** implement `generate(factsBundle, style, schema)`. Registry fields: name, params, quantisation, host, region, ctx, tokens/s measured on the target box, eval scores per task, cost per 1k tokens, status (candidate/active/retired). Selection = the best-scoring active model in the region that meets the latency budget. VSAP gateway: the interface is defined, with a stub that throws `NotImplemented`.
- **Inference on 16GB CPU:** benchmark 3–8B instruct models at Q4/Q5 (for example Qwen 2.5/3, Llama 3.x, Mistral, Phi), and pick by measurement. Use a GBNF/JSON-schema constrained output for classification. Cap context. Use a warm keep-alive. Inference must never sit on the ACK path.

---

## 10. Testing and measurement

### 10.1 Test suites (all written first)
- **T1–T23** from the resurrection review, rewritten for this architecture. Map each one in `docs/reference/t-mapping.md`.
- **F1** cross-tenant (as app role, through both API and direct SQL).
- **F2** egress: static AST/URL scan of code and config against the allowlist, plus a runtime container test where an `nftables` default-deny drop is verified (a connection to a non-allowlisted IP fails).
- **F3** grounding: a property-based test (fast-check) that generates drafts with injected prices, dates, times, postcodes, names and phones. Each one that isn't in the bundle or the enquiry gets blocked. Normalise formats (£1,200 = 1200.00; 07… vs +447…; dates across formats).
- **F4** region: a null region is refused, and a cross-region write without a contract is refused.
- **F5** erasure registry coverage, plus an end-to-end erase that leaves no recoverable PII (DB scan + crypto-shred check + backups policy noted).
- **F6** approvals: single-use, expiry in the query, digest mismatch, and concurrent double-consume (only one wins).
- **F7** ACK latency p50/p95/p99 under a load of 20 concurrent enquiries on the 16GB box, while the model is busy.
- **F8** no consequential action without an approval or a grant, in either mode.
- **T-BOOT, T-AUD, T-SEC, T-RES**, plus migration up/down, idempotency (replay every webhook twice → one effect), and chaos (kill the worker mid-step).
- Coverage: `domain`, `grounding`, `approvals`, `autonomy`, `privacy` need ≥ 95% branch coverage. Mutation testing (Stryker) on `grounding` and `approvals`, with a score of ≥ 80%.

### 10.2 Reply record (I10)
Every outbound or blocked draft writes: intent + confidence, facts_used, facts_missing, grounding result + failures, template vs model, model id, tokens, latency per stage, autonomy decision, approval outcome, owner edit diff (size + category), send result and cost.

### 10.3 Metrics (SQL views in `packages/metrics`)
Floors (must = 0), quality (intent accuracy, fact accuracy, correct-unknown rate, booking completion, owner edit rate), speed (ACK, draft by tier, resolution), ops (approvals/100, owner minutes/enquiry, failure rate, queue age), cost (per resolved enquiry). `pnpm eval` runs the 100-enquiry corpus and writes `eval/reports/<date>.md`. CI fails if any quality metric drops more than 2 points against the last accepted baseline.

### 10.4 Competitive harness
`eval/competitive/` holds 50 scripts and a manual-run harness that logs timings. It doesn't automate rival sites. Dan checks vendor terms first, and the results are recorded with dates.

---

## 11. Phases (one PR each)

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | Repo, CI, lint rules, gitleaks, Testcontainers, all F/T tests written **red** | CI runs; every test listed fails for the right reason |
| 1 | Schema, region, RLS, boot guard, audit chain, crypto envelope | F1, F4, T-BOOT, T-AUD green |
| 2 | Intake (webform, email, SMS), auth, tenancy, egress client + allowlist + nftables, processor register generator | F2 green; register generated |
| 3 | Deterministic core: intent rules, slots, knowledge records + versioning, eligibility, pricing, availability, booking | Corpus intent/eligibility baseline recorded |
| 4 | ACK path + grounding | F3, F7 green; ACK p95 measured |
| 5 | LLM interface, registry, Ollama provider, eval harness, VSAP stub | Model benchmark table on target box |
| 6 | Approvals, autonomy engine, outbox sends, owner UI inbox | F6, F8, T-RES green |
| 7 | Privacy: erasure registry, DSAR, retention, consent ledger | F5 green; erase E2E |
| 8 | Metrics views, weekly report, baseline report | Baseline report v1 |
| 9+ | Billing, reminders, review requests, new channels, region #2 cell | Separate contracts |

---

## 12. Constraints

Local models only. No external AI calls. No deployment to production. No voice channel in v1 (keep the adapter interface ready for it). No production secrets. No telemetry to third parties. Every processor goes on the allowlist and the register. No new dependency without a line in `docs/adr/` (licence, maintenance, why). Use permissive licences only (MIT/Apache/BSD/ISC). AGPL needs a human decision.

## 13. Reporting (every PR)

1. Test table: id, status, and evidence (a CI link or output).
2. Measured: ACK p50/p95/p99, model tokens/s and draft latency per tier on the target box, corpus metrics.
3. A `DEVIATIONS.md` entry for every difference from this contract: what, why, risk, and proposal.
4. Any new UNKNOWN about the law or about the product, listed for Dan. Don't decide it.

## 14. Amendments
Only Dan amends this contract. To amend it: a PR to this file, with a version bump and a changelog entry. Sections 3 and 8.3 need an explicit "constitutional amendment" note.

---

## 15. Open decisions carried from Design v4
1. Approve I1–I12. 2. F7 target (10s default). 3. UNKNOWN policy (`all` default). 4. First cell = UK on the 16GB VPS. 5. Counsel for the regional regimes, starting with the EU. 6. **New:** default autonomy thresholds (N, X) for §7.2. 7. **New:** the first 5 trades, and confirmation that they're unregulated for conversation purposes.

---
---

# PART B — Full customer lifecycle (added in v1.1)

Part B overrides Part A wherever they conflict, except §3 and §8.3, which stay binding.

## 16. Two lifecycles on one engine

Sevari runs two lifecycles on a single, generic lifecycle engine. Don't build two products.

- **Lifecycle V (Veylith → tenant):** Veylith acquires, onboards, supports, bills and offboards the tenant businesses that use Sevari.
- **Lifecycle T (tenant → end customer):** each tenant business does the same with its own customers, through Sevari.

The engine is a **typed state machine per subject** (`prospect`, `lead`, `customer`, and so on), with these properties:
- States, transitions, guards, timers, and the action class of every transition are **data** (config packs), not code.
- Every transition is idempotent, audited, and region-scoped, and writes a reply or event record (§10.2).
- Every transition that sends something, moves money or changes a contract passes through the autonomy policy (§7). Nothing bypasses it.
- Lifecycle V's tenant is Veylith itself (a "house tenant" in the UK cell). Dogfood it. If Veylith's own lifecycle can't run on the same engine, the engine isn't generic enough.

### 16.1 Stages (both lifecycles use these; the packs fill in the detail)

| # | Stage | Lifecycle V (tenant acquisition) | Lifecycle T (end customer) |
|---|---|---|---|
| 1 | Source | Referral, inbound, marketplace, opt-in list, gated outbound (§17) | Inbound enquiry, marketplace lead, referral, repeat customer, gated outbound for the tenant (§17) |
| 2 | Contact and qualify | First touch, qualification against ICP and eligibility | Acknowledge, triage, eligibility |
| 3 | Offer | Proposal, plan, DPA and contract pack | Quote, booking proposal |
| 4 | Commit | E-signature, contract, activation (**human**, §8.3) | Acceptance, deposit, booking |
| 5 | Onboard | Interview, knowledge records, channel set-up, test enquiries, go-live checklist | Customer record, consent, preferences, job brief |
| 6 | Deliver | Service operation, health monitoring | Job scheduling, reminders, completion |
| 7 | Support | Tickets, status, incidents | Questions, changes, rebooking |
| 8 | Bill | Subscription billing, dunning (§19.4) | Invoice, payment link, chasing (§19) |
| 9 | Reconcile | Subscription payments vs invoices | Payments vs invoices, bank feed (§19.3) |
| 10 | Resolve | Complaints, disputes, SLA credits (§20) | Complaints, refunds, disputes (§20) |
| 11 | Retain and grow | Usage reports, upgrade prompts, renewals | Review requests, reminders, repeat prompts (opt-in) |
| 12 | Offload and exit | Offboarding, export, erasure (§21) | Opt-out, erasure, record retention, escalation to human or third party (§21.3) |

A stage with nothing automatable still exists, as a human task with the facts already gathered.

## 17. Sourcing and outbound contact

The aim is the strongest compliant capability on the market, built so that more can be switched on later by config, never by code. **Everything in this section is outbound-capable but defaults OFF per tenant and per region until the gates are met.** I haven't verified any legal requirement below. Counsel confirms before each gate opens.

### 17.1 Source types (a registry, `lead_sources`)
Each source has: `type`, `lawful_basis`, `data_categories`, `acquired_from`, `art14_notice_method`, `retention`, `counsel_signoff`, `enabled`.

| Tier | Source | Default | Gate |
|---|---|---|---|
| A | Inbound (web form, email, SMS, marketplace, referral, customer-initiated) | ON | Normal consent and notice |
| B | Opt-in lists captured by Sevari or the tenant (double opt-in, with a consent ledger) | ON | Consent ledger entry per person, per purpose and channel |
| C | Outbound to **corporate subscribers** (limited companies, LLPs, public bodies) at role or corporate addresses | OFF | Counsel sign-off per region, written legitimate interest assessment (LIA) for each campaign type, suppression checks |
| D | Outbound to **sole traders and partnerships** (treated like individuals under PECR in the UK) | OFF; consent-only | Consent only. Code MUST NOT treat sole traders as corporate |
| E | Lead discovery from public data (registers, directories, the open web) | OFF | DPIA, a data-source register entry per source, Art. 14 notice within the one-month limit (or a documented exemption), terms-of-use check, counsel sign-off. No scraping of sites whose terms forbid it |
| F | Purchased or third-party lists | **Disabled in code** | Constitutional amendment (§14) only |

### 17.2 Rules the code MUST enforce
- **Suppression is global and first.** One suppression ledger per cell (email, phone, domain, postcode+name hash) is checked immediately before every outbound send, in the same transaction as the send reservation. Opt-outs take effect immediately, and they're honoured across tenants where the person opted out of the sender class, not just one tenant.
- **TPS/CTPS** (and each region's equivalent do-not-call or preference register): checked before any live or automated voice call or SMS where required. No outbound voice in v1; the interface and gate exist.
- **Identity in every message:** sender, tenant identity, an unsubscribe route, and the privacy notice link.
- **Frequency caps and quiet hours** per contact, per tenant and per region (config).
- **Purpose limitation:** data collected for one purpose can't feed another without a recorded compatibility assessment. A source-to-purpose table is enforced in the DB.
- **Provenance on every contact:** `source`, `basis`, `captured_at`, `captured_by`. A contact without provenance can't be messaged (an invariant, tested).
- **Outbound campaigns are always `approval`-class** until a tenant earns a `marketing` grant (§7.2). First-touch cold outreach (Tier C) MUST NOT be eligible for a grant without a human decision.
- **No profiling with legal or significant effect** (Art. 22). Lead scoring may prioritise human attention. It MUST NOT refuse service automatically.
- **Special-category and children's data:** never sourced, never inferred, and blocked at ingest.
- **Marketplace leads:** each marketplace adapter declares its terms of use, lawful basis and permitted reply channels. Contact outside the permitted channels is blocked.
- Tests: F9 suppression race (concurrent send and opt-out, where the opt-out always wins), F10 provenance, F11 sole-trader classification, F12 TPS/preference check, F13 frequency and quiet hours.

### 17.3 Future-proofing
Source adapters, channel adapters and consent models are plugins that declare their egress hosts, data categories and lawful bases. Adding a country's rules means adding a `regions/<code>.yaml` rule pack (outbound permissions by recipient class and channel), not touching the core.

## 18. Onboarding

**Lifecycle V (tenant onboarding), automated except activation:**
1. Signed contract pack (DPA, processor register extract, sub-processor list, SLA): generated from templates by the system, with human review of any non-standard term.
2. Structured onboarding interview producing typed knowledge records (I5): prices, services, hours, areas, policies, tone. Each record is previewed and confirmed by the owner.
3. Channel set-up wizard (email, SMS number, web form, marketplace connection), with automated verification (DNS, SPF/DKIM/DMARC, a test message).
4. Data import (contacts, past jobs, invoices) through typed importers, with a provenance and lawful-basis step per import. An import without a recorded basis is blocked.
5. **Shadow mode:** the tenant runs in assist mode on a synthetic and a live-shadow enquiry set. A go-live report shows grounding, acknowledgement and unknown rates.
6. Go-live checklist, automatically checked. **Activation is a human decision (§8.3).**

**Lifecycle T (end-customer onboarding):** capture identity and contact details with minimum data, record consent per purpose and channel, show the privacy notice, build the job brief, set up the customer portal or magic-link access, and confirm communication preferences.

Tests: T-ONB-1 (no activation without the checklist plus a human approval), T-ONB-2 (an import without a basis is blocked), T-ONB-3 (a tenant can't leave shadow mode automatically).

## 19. Finance

### 19.1 Money-flow architecture: undecided, so it's a port
The money-flow decision is **not made** (owner: Dan, with counsel). Build a `MoneyPort` interface with two implementations behind a config flag:

- **Mode 1 — Direct (default):** the customer pays straight into the tenant's own processor account (the tenant is the merchant). Sevari holds no funds, creates payment links and records events. Sevari's own subscription revenue uses Veylith's own account in the same way.
- **Mode 2 — Platform (disabled, locked):** a licensed processor's platform product holds and splits funds (for example, Stripe Connect-style), and Sevari takes a fee. **The code path MUST exist behind the interface but MUST NOT be enabled until counsel has confirmed Sevari's regulatory position** (payment services and e-money rules), recorded in `docs/adr/` and in a `money_mode_signoff` field.

Sevari MUST NOT itself hold, pool, or transmit customer funds in any mode. A processor does. No Sevari-controlled bank account may receive end-customer funds. Include a test (F14) that fails if any code path creates a payout, transfer or balance operation while `money_mode != platform_signed_off`.

### 19.2 Invoicing and payments (Lifecycle T)
- Invoices are generated deterministically from completed jobs and accepted quotes. The model never computes money. Amounts use integer minor units, a currency code, and a tax rule from region config (VAT status per tenant: a record the owner confirms. Sevari doesn't decide tax treatment).
- Payment links come from the allowlisted processor adapter. Webhooks are verified, deduplicated and idempotent.
- Deposits, part-payments, refunds and credit notes are modelled as ledger events.
- **Ledger:** an append-only, double-entry ledger per tenant (`ledger_entries`, with a DB constraint that debits equal credits per transaction). Invoices, payments, refunds, fees and credit notes all post to it.
- Chasing: a schedule the owner sets (tone, intervals, caps). Reminders are `invoice_send` class. Statutory late-payment interest is never added unless the owner's records say it applies.
- Refunds: always an approval above the owner's own autonomous limit, and **always an approval in v1**.

### 19.3 Reconciliation
- Sources: processor payout reports and webhooks, plus bank feeds. A bank feed requires open banking access through a **regulated third-party provider** (an authorised account-information provider). Sevari isn't to become an authorised account-information provider on its own. Register the provider as a processor, with the owner's explicit connection consent, and handle the re-consent cycle the rules require.
- Matching engine: deterministic, in layers: exact reference, then amount + date window + payer, then fuzzy, then **unmatched → human queue**. The model doesn't match money. It may be used to suggest an explanation of an unmatched item, shown as a suggestion only.
- Outputs: matched, partial, over/under payment, duplicate, unmatched. Each decision is stored with its rule, confidence and evidence. Auto-match applies only to exact and high-confidence layers. Everything else needs a human.
- Tests: F15 (ledger balances to zero, always), F16 (replay the same webhook or bank line twice, one effect), F17 (matching never auto-applies below the confidence threshold), F18 (reconciliation totals equal processor totals on the fixtures).

### 19.4 Subscription billing (Lifecycle V)
Plans, usage metering from reply records (per resolved enquiry, per seat, per channel), invoices, proration, tax per region, dunning (retry schedule, notices, the grace period, suspension). **Suspension and termination for non-payment are human-confirmed** (§8.3: irreversible and consequential), and the notice periods come from the contract. Billing never reads message content. It reads only metering counters.

### 19.5 Accounting sync
An `AccountingPort` with adapters (Xero, QuickBooks, FreeAgent first, which I haven't verified for API terms). Sync is one-way by default (Sevari → ledger), with a second direction (read chart of accounts and tax codes) for mapping. Each push is idempotent, has a stored mapping, and an owner-visible sync log. Sync failures raise a human task. Tokens are stored encrypted per tenant (§6.3) and are crypto-shredded on disconnect.

### 19.6 Finance data protection
Financial data is category `financial` in the erasure registry. Statutory retention (the UK's tax record rules, and each region's equivalent, which counsel confirms) overrides erasure for the retained fields. The registry's `retain-legal-hold` entry names the reason and the end date. Everything else is erased or anonymised.

## 20. Complaints, disputes and resolution

A first-class workflow, not a support ticket with a tag.

1. **Detect:** intent rules and the model flag a complaint, dispute, chargeback, safeguarding concern, legal threat, regulator mention or discrimination allegation. A false negative is worse than a false positive, so thresholds are tuned for recall.
2. **Classify and route (deterministic):**
   - Standard service complaints → automated workflow (steps below).
   - Anything in the **always-human list**: legal threats, regulator contact, safeguarding, harassment or discrimination, injury or damage over a threshold, data protection requests (route to §21), media, vulnerable-customer indicators → immediate owner escalation, with a case file and no auto-reply beyond a holding acknowledgement.
3. **Standard workflow:** acknowledge (deterministic, with the tenant's complaint-handling timeline), gather facts (job record, messages, photos, invoices), propose resolutions from the tenant's **resolution policy** (a typed knowledge record: when a redo, partial credit or refund is offered, and the limits), draft the reply (grounded), then `approval` or a grant. **The model never invents compensation.** Any remedy outside the policy is an owner decision.
4. **Dispute and chargeback handling:** evidence pack assembled automatically from the ledger and audit log (a human submits).
5. **Closure:** a root-cause tag, a satisfaction check (opt-in), and a clock. Timers per stage, with breach alerts.
6. Complaints data feeds the autonomy kill switch (§7.2) and the tenant's quality metrics.
7. Lifecycle V complaints (tenant → Veylith) run the same workflow against Veylith's SLA, with SLA credits computed deterministically and approved by a human.

Tests: T-CMP-1 (a legal threat produces no model reply and an escalation), T-CMP-2 (a remedy outside the policy is blocked), T-CMP-3 (the complaint clock and breach alerts), T-CMP-4 (a vulnerable-customer flag disables auto-send).

## 21. Offloading, offboarding and erasure

### 21.1 Tenant offboarding (Lifecycle V)
Triggered by the tenant, by non-payment or by Veylith. Automated steps: a notice per the contract, final invoice, the data export (a portable, machine-readable bundle generated from the registry), a grace window, a retention hold for statutory records, then erasure (crypto-shred the DEK, delete or anonymise per the registry, certificate of erasure generated). **Evidence deletion and the final erase trigger need a human (§8.3).** Processor offboarding (revoke tokens, disconnect channels, release numbers) is automated.

### 21.2 End-customer rights (Lifecycle T)
DSAR, rectification, erasure, restriction, objection and portability requests: detected on every channel, logged, clocked (one month, extendable under the law as counsel confirms), the identity verified, the export or action assembled automatically, and **released by a human** (§8.3). Controller and processor roles are set per tenant: for tenant data, the tenant is the controller and Sevari the processor, so Sevari routes the request to the tenant and doesn't answer it itself. The role model is explicit in config. Veylith is a controller for its own customers' (the tenants') data.

### 21.3 Offloading work to humans and third parties
"Offloading" means handing a case out. Build it as a first-class action:
- **To the owner or staff:** an escalation with a case file, an SLA clock and a reason code.
- **To an external party** (a subcontractor, a specialist, a partner firm, an insurer, a regulator, a debt-recovery agent): an `offload` record with the lawful basis, minimum data bundle, recipient, purpose, and a processor or controller status. It's always an `approval`. The recipient must be on the processor register or have a recorded controller-to-controller basis. **Debt recovery and regulator contact are human-only.**
- **To a customer:** a handover message with the status and the next step. The case is closed or transferred, never dropped (a queue-age metric and a test that no case is in a state without an owner).
- **Capacity offload:** where the tenant is full, optionally refer the customer to a partner tenant. This needs the customer's consent to share data with the partner, and is off by default.

Tests: F19 (offload to an unregistered recipient is blocked), F20 (an exported bundle contains only registry-declared fields), F21 (erasure end-to-end including the processor tokens and the search index and caches), T-OFF-1 (no case is left without an owner).

## 22. Support and customer service (both lifecycles)

- Omnichannel threads, with one conversation per contact across channels.
- Self-service portal or magic-link pages: booking status, invoices, reschedule, and preferences and privacy controls (consent withdrawal in one click).
- Knowledge-grounded answers only (I5 and I6). Anything outside the records is an UNKNOWN.
- Status page and incident communication for Lifecycle V, with templates and a human approval for any post.
- Vulnerable-customer handling and accessibility: a flag that disables auto-send and prioritises human contact. Plain-language templates. Accessible portal (WCAG 2.2 AA target, tested with axe in CI).
- Language: the language is detected and replied to only in languages that a tenant has enabled and the registry has evaluated (a model-registry per-language score). It falls back to a human otherwise.
- Quality: an automatic QA sample of 5% of sent replies is shown to the owner weekly.

## 23. Retention, analytics and growth

Retention and growth messages (reviews, repeat prompts, renewals) are `marketing` or service messages, classified deterministically, and each message class has a documented lawful basis. Service messages and marketing messages are never mixed in one send. Analytics runs on pseudonymised data inside the cell. Cross-tenant benchmarking uses only aggregated, thresholded (k-anonymity) data, and only where the contract allows it. Model fine-tuning on tenant data is **not allowed** without an explicit contract term, a DPIA and a human decision.

## 24. Updated automation register (replaces §8.1–8.3 for the lifecycle stages)

| Stage | Fully automatic | Automatic with approval (assist or until a grant is earned) | Always human |
|---|---|---|---|
| Source | Inbound capture, Tier B, provenance, suppression | Tier C campaigns | Tier D/E enablement, new sources, any Tier F request |
| Contact/qualify | ACK, triage, eligibility, slots | Replies, first outreach | Refusal of service with a significant effect |
| Offer/commit | Quotes from records, booking proposals | Quotes outside records, bookings, changes | Contract activation, non-standard terms |
| Onboard | Interviews, wizards, verification, shadow mode | Imports | Activation, lawful-basis decisions |
| Deliver/support | Reminders, status, FAQ from records | Changes, cancellations | Vulnerable-customer decisions, incidents |
| Bill/reconcile | Invoices, links, exact matches, ledger, sync | Chasing, refunds, credit notes, fuzzy matches | Write-offs, suspension and termination, platform money mode |
| Resolve | Holding ACK, evidence packs | In-policy remedies | Out-of-policy remedies, legal, regulator, safeguarding, chargeback submission |
| Offboard/offload | Exports, token revocation, schedules | Offloads to registered parties | Final erasure, DSAR release, debt recovery, regulator contact |

## 25. Phases for Part B (separate PRs; each starts with its tests red)

| Phase | Scope | Exit |
|---|---|---|
| 9 | Lifecycle engine (state machines as data), subject model, transition audit, timers | Both lifecycles run on the engine with the house tenant |
| 10 | Consent ledger, suppression, provenance, lead-source registry, Tier A/B | F9–F13 green (Tiers C–F disabled and tested as disabled) |
| 11 | Tenant onboarding (V) and customer onboarding (T), shadow mode | T-ONB-1..3 green |
| 12 | Ledger, invoices, MoneyPort (Mode 1 only), payment adapter, reconciliation engine | F14–F18 green |
| 13 | Subscription billing, dunning, accounting adapters, bank-feed provider adapter | Sync fixtures green |
| 14 | Complaints and disputes workflow | T-CMP-1..4 green |
| 15 | Offboarding, DSAR, offload, portal | F19–F21, T-OFF-1 green |
| 16 | Outbound Tiers C/E behind gates (**only after counsel sign-off**) | Gate evidence in `docs/adr/` |
| 17+ | Voice, further regions, Mode 2 money flow (**only after counsel sign-off**) | Separate contracts |

## 26. New processors implied (all must be on the allowlist and the register before use)
A payment processor, an open-banking account-information provider, accounting platforms (the three named above), an e-signature provider (or a built-in one), an email and SMS provider, and a status-page host (or self-hosted). Pick EU/UK-hosted options for the UK cell where possible, and for each one record the DPA, sub-processors, transfer mechanism and region. **"No third-party processors" is no longer a valid claim. The valid claim is "only declared processors, on a published list".**

## 27. Open decisions added by Part B
1. Money flow: Mode 1 only for now, or commission counsel on Mode 2 before the build reaches Phase 12 (the build doesn't wait for it).
2. Which processors, accounting platforms and open-banking provider to use first.
3. Which outbound tiers to open first, and in which region (the build ships with C–F off).
4. The complaint-resolution policy template: the default remedy limits for each trade.
5. The tenants' controller/processor role, and whether Veylith will take the controller role for any tenant-side data (counsel).
6. Whether capacity offload to partner tenants is wanted at all.
7. Retention periods per category, per region (counsel).
8. Whether to have model-based wording in the complaint workflow, or templates only for the first release.

---
---

# PART C — Decisions, human feedback, governed learning, platform hardening (added in v1.2)

Part C overrides Parts A and B wherever they conflict, except §3 and §8.3, which stay binding. Part C may tighten those two. It may never loosen them.

## 28. Decision log

| # | Decision | Status | What it means for the build |
|---|---|---|---|
| D1 | **Money flow.** Mode 1 (direct to the tenant's own processor account) is the only mode enabled. Mode 2 (a processor holds and splits funds) is built behind `MoneyPort` and stays locked. | **CONFIRMED by Dan, 12 Oct 2026: Mode 1 only.** Mode 2 stays locked; revisiting it needs a constitutional amendment (§14). | Sevari never holds funds. Phase 12 ships Mode 1 only. The `money_mode_signoff` field stays null. Counsel on Mode 2 is a separate, dated task and doesn't block the build. |
| D2 | **First providers** (payments, accounting, open banking, e-signature, email, SMS, status page). **Claude Code recommends. Dan approves.** | **Decided: delegated to Claude Code, with a Dan approval gate.** | See §29. |
| D3 | **Outbound tiers opened first.** Only Tiers A (inbound) and B (opt-in) are enabled. Tiers C–F are built, tested as disabled, and stay off until counsel signs off per region. | **CONFIRMED by Dan, 12 Oct 2026: Tiers A and B only.** Opening any other tier needs counsel sign-off, an ADR and a Dan decision. | No campaign code may run in production for Tiers C–F. Opening a tier is a human decision recorded in `docs/adr/`. |
| D4 | **What the system may learn from.** Per-tenant learning, cross-tenant aggregate learning and model fine-tuning are all **permitted in design**, each behind the guardrails in §31–§35. | **Decided by Dan.** | Nothing learns in production until the learning gate (§35) has passed. Each learning type is a separate switch, off by default. |

Rule: a provisional decision is built as the narrowest safe option. Changing it later must need config or a gate, never a rewrite.

## 29. Provider selection (D2)

Claude Code produces one ADR per provider category, in `docs/adr/providers/`, before any provider code is merged. Each ADR contains:
- At least three candidates, UK/EU-hosted where possible, with the evidence for each (documentation links, licence or terms, API stability, pricing).
- The DPA, the sub-processor list, the transfer mechanism, the data location, the breach-notification terms, and the data export and deletion capabilities.
- Whether the provider needs Sevari to hold any authorisation. For open banking, the provider must hold the account-information authorisation, not Sevari.
- Whether the API terms allow what Sevari will do (for accounting platforms, check marketplace and app terms).
- The egress hosts, the secrets needed, and the failure modes.
- A swap cost: the port interface, and what changes if the provider is replaced.
- A recommendation, with the reasons and risks. **Dan approves each ADR before the provider appears in `egress.allowlist.yaml`.** Until then the adapter exists only as a fake that runs against recorded fixtures.

Claude Code must not claim any fact about a provider that it can't evidence. Anything unverified is listed as an UNKNOWN for Dan.

## 30. Human-in-the-loop (HITL) feedback must be acted on, never assumed

This is a core invariant: a human input that is recorded but doesn't change behaviour is a defect.

### 30.1 Every human input is a typed record
`human_inputs(id, tenant_id, region, kind, subject_ref, question_id, response, response_digest, responder_id, responder_role, received_at, channel, consumed_by, effect_receipt_id, status)`.
Kinds include: approval, rejection, edit, correction, escalation outcome, owner knowledge update, label, complaint outcome, DSAR release, autonomy change, activation, legal sign-off, and free-text instruction.

### 30.2 The closure rules (these become invariants INV-12 to INV-16)
- **INV-12 No input without a consumer.** Every request for human input is created with a named consumer (a state transition, a record update, or a learning signal). A response that has no consumer fails validation.
- **INV-13 No effect without a receipt.** When a human input is applied, the system writes an `effect_receipt` linking the input to the exact change (the row version, the transition id, the sent message id or the config version). The input stays `pending_effect` until the receipt exists, and an alert fires if it stays pending past its SLA.
- **INV-14 No assuming.** The system MUST NOT infer an answer to a question that was put to a human. Silence, timeout, an ambiguous reply, a reply from someone without the right role, or a reply to a stale question all lead to a defined state: **re-ask, escalate or fail closed**, per the question's declared policy. They never lead to a default-approve. Each question type declares its timeout behaviour, and the schema requires it.
- **INV-15 Stale answers are rejected.** A response binds to the question's content digest and version. If the underlying facts changed since the question was asked, the response is rejected and the question is re-asked with the new facts.
- **INV-16 Feedback is verified, not trusted.** A human edit is parsed into a structured diff, and the system checks that the change it made matches what the human did. For example, if the owner changes the price in a draft, the system asks whether this was a one-off correction or a knowledge record update, and doesn't guess. The answer then drives a knowledge record update, a template update or no learning at all.

### 30.3 Structured questions, not free text
Questions to humans are generated with: what's being asked, the facts, the options, the default-if-no-answer (always the safe option), the deadline, the consumer and the role allowed to answer. The owner UI and each channel adapter render them. Free-text instructions are allowed, but are converted into a structured proposal that the human confirms before it takes effect.

### 30.4 Clarification loop
When a response is ambiguous (for example, "yes but cheaper"), the system asks a specific follow-up. After N failed clarifications (config) it escalates to a human task. It never proceeds on its best guess.

### 30.5 Role and authority checks
The responder's role is checked against the question's required role in the database. A staff member can't answer an owner-only question. Reserved decisions (§8.3) need a named human and, where the contract says so, two-person approval (Dan plus counsel, where a legal sign-off is involved). Authority is recorded on the receipt.

### 30.6 Human input latency and fatigue
Each human queue has an SLA, a priority and a batching rule. Questions are de-duplicated and grouped (for example, one digest instead of twelve pings). Measure owner minutes per enquiry, approval fatigue (the rubber-stamp rate: approvals in under 2 seconds, or 100% approval over a long run) and escalate rubber-stamping back to the owner as a warning, because blind approval defeats the control.

### 30.7 Tests
F22 (a response with no consumer is rejected), F23 (an applied input always has a receipt, and a missing receipt triggers an alert), F24 (timeout, ambiguity, wrong role and stale digest each lead to the declared safe state, never to approval), F25 (an owner edit generates a clarification, not a silent knowledge update), F26 (a reserved decision can't be answered by an unauthorised role), F27 (rubber-stamp detection).

## 31. Governed self-learning: HIVE (D4; named in §88)

### 31.1 Principle
The system learns by **proposing changes, testing them, and promoting them through gates**. It never changes live behaviour in place. Learning improves wording, classification, ranking, thresholds and retrieval. **It never creates facts, never changes the legal perimeter, and never expands its own authority.**

### 31.2 What can be learned (the learnable surface) and what can't
| Learnable (versioned artefacts) | Not learnable (frozen) |
|---|---|
| Template variants and wording style per tenant | Anything in §3 and §8.3, and the reserved list |
| Intent classifier rules, thresholds and keyword lists | Grounding rules and fact sources |
| Retrieval and ranking of FAQ items | Approval, expiry, digest and consent logic |
| Slot-extraction patterns | Egress allowlist, region and tenancy rules |
| Triage priority and queue ordering | Autonomy grants (the system can only **revoke**; a grant needs a human) |
| Model adapters (LoRA-style) for wording and classification, per region | Lawful bases, retention and erasure rules |
| Eval corpus growth (labelled, after human review) | Prices, hours, service areas and policies (owner records only) |

### 31.3 Learning loop (all steps are code, audited, and idempotent)
```
signals (edits, approvals, rejections, outcomes, complaints, labels)
   → eligibility filter (lawful basis, consent term, region, quality, no special category)
   → candidate generator (propose artefact change)
   → offline evaluation on the frozen golden corpus + the tenant's held-out set
   → regression gate (must not worsen any floor; must improve a target metric)
   → shadow mode (runs alongside live, outputs compared, nothing sent)
   → canary (a small share of one tenant's drafts; assist mode only)
   → HUMAN GATE (Dan, or the tenant owner for per-tenant artefacts within their scope)
   → promote (a versioned release, with a signed manifest) → monitor → auto-rollback
```
Every artefact has: version, parent, training or derivation data lineage, eval scores, approver, rollout state and a rollback target.

### 31.4 Three learning scopes, each its own switch (default OFF)
1. **Per-tenant learning.** Uses only that tenant's own signals. Artefacts apply only to that tenant. The owner can see, accept, reject or reset any learned change, and the tenant can switch learning off.
2. **Cross-tenant aggregate learning.** Allowed only if: the tenant contract has the term; a DPIA covers it; the data is aggregated with a minimum group size (k ≥ a configured number, default 20 tenants) and noise or thresholding where counts are small; no free text, names, contact details, prices or customer content cross the tenant boundary. Only statistics (rates, distributions and rule-level effectiveness) and **owner-approved, de-identified phrasing patterns** are shared. A test (F28) proves that a canary string planted in one tenant never appears in another tenant's artefacts or prompts.
3. **Model fine-tuning.** Allowed only if: contract term and DPIA are in place; the training data is region-resident; the training job runs inside the region's boundary on infrastructure listed on the processor register (see §33 on compute); the output is an adapter registered in the model registry, evaluated like any other model, and promoted only through the human gate; every training example has lineage back to its source rows. **Fine-tuning on raw customer message content is off unless a tenant opts in per class of data.** Default training data is owner-edited drafts and human-labelled examples, with personal data replaced by typed placeholders (`<NAME>`, `<PHONE>`, `<POSTCODE>`).

### 31.5 Poisoning, injection and quality controls
- Inbound customer messages are **untrusted input**. They never become training data automatically. A human label or an owner edit is the learning signal, and a customer's text is never an instruction to the system.
- Per-tenant influence caps: no single tenant or contact can contribute more than a set share of a shared artefact's evidence.
- Outlier and anomaly detection on signals (sudden edit-rate shifts, bulk identical edits, an unusual rejection pattern). Suspect signals are quarantined for human review.
- Rubber-stamp filtering: approvals given in under 2 seconds, or in bulk, aren't treated as positive labels.
- Labels from edits are accepted only after clarification (INV-16), so an owner fixing a one-off typo doesn't train the system to change its pricing wording.

## 32. Drift prevention

Drift is defined and monitored, not hoped against.

- **Golden set:** a frozen, versioned, human-labelled corpus (the 100 synthetic enquiries to start, then growing by human-reviewed additions only). Every release and every learned artefact is scored on it. A drop of more than the configured margin on any floor or quality metric blocks promotion. Floors must remain zero.
- **Behavioural contracts:** metamorphic and invariance tests (for example, the same enquiry with different names, formats and trades must give the same intent and the same grounding result). Property tests for the grounding and approval logic run against every candidate artefact.
- **Live drift monitors** per tenant and per cell: input distribution (PSI or a similar measure on intents, channels and lengths), output distribution, grounding-block rate, unknown rate, owner edit rate, complaint rate, approval-rejection rate, latency. Thresholds trigger: alert, freeze learning for that scope, or **automatic rollback to the last good artefact**.
- **Tighten-only automation:** automatic changes may only move toward more caution (revoke a grant, raise an escalation threshold, freeze learning, roll back). Moves toward less caution (more autonomy, lower thresholds, wider scope) need the human gate.
- **Lineage and reproducibility:** any production reply can be re-run with the exact artefact versions, the model, the prompt and the facts bundle that produced it. A test (T-REPLAY) replays a sample weekly and compares outputs.
- **Regression budget and cool-down:** at most one promoted change per scope per week (config), so cause and effect stay attributable.
- **Kill switch:** per tenant, per scope, per cell and global. It reverts to the last human-approved baseline artefact set.
- **Periodic re-baselining:** a quarterly, human-reviewed golden-set refresh that includes new failure cases found in production.

## 33. Fine-tuning compute and privacy engineering
- A 16GB CPU VPS isn't a training platform. The contract requires: training only on infrastructure that is in the same region as the data and on the processor register, with a DPA. **Open question for Dan:** a rented in-region GPU on demand, an owned GPU box, or a provider. Until decided, the fine-tuning pipeline is built and tested end to end on a tiny model and synthetic data, and it's disabled in production.
- Training data is minimised, de-identified with typed placeholders, and checked by a PII scanner. A test fails the pipeline if any detected personal-data pattern reaches the training set.
- **Erasure and learning:** every training example carries lineage. When a data subject's records are erased or a tenant leaves, the affected examples are removed from the training store at once, and any adapter trained on them is flagged `tainted`. Tainted adapters are retrained without the data on a schedule (config, default within 30 days, which counsel confirms) and are retired when the retrain is promoted. The erasure certificate lists the adapters affected. A test (F29) checks that erased data leaves no example in the training store and the adapter is flagged.
- **Memorisation tests:** before promotion, run extraction and membership-inference probes (planted canaries) against each adapter. A canary leak blocks promotion (F30).
- No tenant data leaves the region for learning. Cross-region learning shares only approved aggregates (§31.4), and only if a region transfer contract allows it.
- No external AI calls remain a constraint (§12). Training and evaluation use local models only.

## 34. Learning data governance
- Each learning scope has a recorded lawful basis, a purpose-compatibility assessment and a DPIA, as `learning_register` entries. A scope can't be enabled without them (the same pattern as the erasure registry).
- Transparency: the tenant's privacy notice and the contract state what is learned from, and tenants can opt out per scope. Opt-out propagates: signals are excluded from the next run, and artefacts derived from them follow §33.
- Human-oversight evidence: the learning register, the gate approvals and the eval reports are exported as a compliance pack. Counsel decides whether any of the EU AI Act duties (transparency, human oversight, record-keeping) apply to a given deployment. I haven't verified them.

## 35. The learning gate (conditions before any learning is enabled in production)
1. Phases 0–8 are green and the baseline report exists.
2. The golden set, drift monitors, rollback and kill switch are tested (T-DRIFT, T-ROLL, T-KILL).
3. The learning register entry exists for the scope, with counsel's sign-off.
4. A written learning-gate ADR is approved by Dan.
5. The scope starts in shadow mode for a minimum period (config), with a report.
Tests: F31 (a candidate that worsens any floor is never promoted), F32 (automatic changes can only move toward caution), F33 (a learned artefact can't touch a frozen item), F34 (promotion without a human gate fails), T-DRIFT, T-ROLL, T-KILL, T-REPLAY, F28–F30 above.

## 36. Making it market-outclassing and future-proof: additional requirements

### 36.1 Product and platform
- **Public API, webhooks and SDK** (OpenAPI-first, versioned, rate-limited, per-tenant keys). Everything the owner UI does goes through the same API. Webhooks are signed and replayable.
- **Vertical and workflow packs as an installable catalogue** (signed, versioned, with an eval suite). New trades and processes are shipped as packs, which is how the platform reaches 20 and then 200 verticals without core changes.
- **Policy as code:** autonomy, consent, outbound and retention rules expressed in a policy engine (OPA/Rego or Cedar), unit-tested, versioned and simulated before activation ("what would this change have done to last month's traffic?").
- **Event sourcing for the business-critical streams** (approvals, ledger, consent, autonomy) with projections, so every state is explainable and replayable.
- **Simulation sandbox:** replay historic or synthetic traffic against a candidate version of anything (a pack, policy, model or artefact), producing a metric diff. This is the main way to make safe change cheap.
- **Multi-user tenants, roles and staff calendars, agency and white-label tenancy** (a parent tenant managing child tenants, with RLS preserved and no cross-visibility by default).
- **Voice, WhatsApp, chat widget and marketplace adapters** ready behind the channel interface. Voice and any new channel go live only after their own contract, consent model and counsel review.
- **Multilingual:** language detection and per-language evaluation, with a human fallback.
- **Customer portal and owner mobile app (PWA)**, with accessibility tested in CI (WCAG 2.2 AA target).
- **Integrations port layer** (calendar, CRM, job management, telephony): each integration is an adapter with a declared egress, data scope and ADR.
- **Cost and capacity engine:** per-tenant cost metering, per-cell capacity forecasts, and model routing by latency budget and load. The GPU upgrade path is a registry entry, not a refactor.

### 36.2 Reliability
- SLOs with error budgets (ACK p95, availability, queue age), alerting, runbooks and game-day drills (kill the DB, the worker, the model host, the network).
- Backups: encrypted, regional, tested restores on a schedule (RPO/RTO set per cell and measured). A backup-and-erasure policy that counsel confirms (how long backups hold erased data, and how erasure is re-applied after a restore). A test replays erasure after a restore (F35).
- Graceful degradation ladder: model down → templates; DB read-replica down → read-only; channel down → queue and alert; a provider outage → fail closed with the owner notified. Each rung is tested.
- Zero-downtime migrations, and expand-contract schema changes only.

### 36.3 Security
- Threat model (STRIDE plus LLM-specific: prompt injection, data exfiltration through output, poisoning, memorisation) in `docs/security/`, reviewed each phase.
- **Prompt-injection hardening:** the model has no tools and no database access, its output is schema-constrained and passes grounding, and customer text is delimited and treated as data. An adversarial test suite (F36) with at least 200 injection attempts runs in CI. No injection may produce an ungrounded fact, a policy change, a leak across tenants or a send.
- Supply chain: pinned dependencies, SBOM, signed images and provenance (SLSA-style), dependency and licence scanning, reproducible builds.
- Secrets in an in-region secrets manager (never in the repo or in env files committed). Rotation is automated and tested.
- Admin and support access: just-in-time, audited, with no standing access to tenant content. Customer-visible access logs.
- Aim for Cyber Essentials Plus and an ISO 27001-aligned control set, with SOC 2 mapping kept as evidence, and an independent penetration test before the first paying tenant. Certification is a human decision.

### 36.4 Compliance automation
- Generated and kept current from code: the ROPA, the processor register, the sub-processor list, the DPIA inputs, the retention schedule, the learning register and the transfer register.
- A DPIA and LIA template library, with the system pre-filling the facts and humans completing the judgement.
- A breach workflow: detect, contain, assess, clock (72 hours), regulator and data-subject notification drafts, with a human releasing them.
- Per-region rule packs, each with `counsel_signoff`, a review date and an expiry. An expired sign-off disables the affected features.
- Consent and preference centre, with proof of consent exportable per person.
- A compliance dashboard for the owner: the tenant's own status, overdue tasks and exportable evidence.

### 36.5 Evidence and the competitive edge
- Publish, per release, an evidence pack: floors at zero, quality metrics, acknowledgement times, the egress list and the processor list. A trust page generated from the same data.
- The 50-script competitive benchmark (§10.4) re-run each quarter, with dated results.
- Customer-facing proof: a per-tenant monthly report (response times, enquiries handled, owner time saved, unknowns raised) generated from the reply records.

## 37. Updated invariants and test index
New invariants: INV-12 to INV-16 (§30.2), plus INV-17 (a learned artefact can't modify a frozen item), INV-18 (automatic changes only move toward caution) and INV-19 (no learning scope runs without a learning-register entry and the learning gate).
New tests: F22–F36, T-DRIFT, T-ROLL, T-KILL, T-REPLAY, plus the earlier F1–F21 and T-series. CI blocks on all of them.

## 38. Phases for Part C (separate PRs, tests red first)
| Phase | Scope | Exit |
|---|---|---|
| 18 | Human-input record, structured questions, closure rules, effect receipts, clarification loop, rubber-stamp detection (this lands early: **it moves up to follow Phase 6**, because approvals depend on it) | F22–F27 green |
| 19 | Provider ADRs and fakes for each provider port | Dan approves each ADR |
| 20 | Golden set, drift monitors, rollback, kill switch, replay, artefact versioning, simulation sandbox | T-DRIFT, T-ROLL, T-KILL, T-REPLAY green |
| 21 | Per-tenant learning loop (shadow only) | F31–F34 green; shadow report |
| 22 | Cross-tenant aggregate pipeline (disabled; canary-string test) | F28 green |
| 23 | Fine-tuning pipeline on tiny model and synthetic data, tainting and retrain on erasure, memorisation probes | F29, F30 green |
| 24 | Public API and SDK, pack catalogue, policy engine, agency tenancy | API contract tests green |
| 25 | Security and reliability hardening, game days, injection suite, restore and erasure replay | F35, F36 green; pen-test brief |

**Ordering rule:** Phase 18 (human feedback) is built before Phase 6 closes, because approvals and the owner inbox are the first consumers of it. If the numbering conflicts, the dependency order wins, and Claude Code records it in `DEVIATIONS.md`.

## 39. Reporting additions
Each PR now also reports: every human input type added and its consumer, its timeout behaviour and its receipt test; every learnable artefact type and its rollback path; every new egress host and processor; and any UNKNOWN the code needs a human to settle.

## 40. Open decisions after v1.2 (owner: Dan)
1. **Confirm D1** (Mode 1 only, or also commission counsel on Mode 2 now).
2. **Confirm D3** (Tiers A and B only to start, or open C or E in the UK once counsel agrees).
3. **Approve the provider ADRs** as Claude Code produces them (D2).
4. **Where fine-tuning runs:** in-region rented GPU, an owned GPU box, or a provider. It's needed before Phase 23 goes beyond synthetic data.
5. **Minimum group size k** for cross-tenant aggregates (default 20), and the retrain deadline after erasure (default 30 days, counsel to confirm).
6. **Autonomy thresholds** (N drafts and X edit rate) from Part A, still open.
7. **Counsel scope:** EU regimes, the UK PECR position on sole traders, the learning register, the backup-and-erasure policy, and any EU AI Act duties.
8. Items 2 and 4–8 from §27 that remain unanswered.

---
---

# PART D — Market, beachhead and trade shortlist (added in v1.4)

Part D overrides Parts A–C wherever they conflict, except §3 and §8.3. It narrows scope. It doesn't widen it.

## 41. Operator and home market
- Operator: Veylith Systems (sole trader), based in **Ellesmere Port, Cheshire West and Chester**. First cell: UK, on the 16GB VPS (D4 in Design v4).
- Home catchment for pilots: Ellesmere Port, Chester, the Wirral and north Cheshire. Records of where the pilots are go in the tenant's `service_area` knowledge record, as with any tenant.
- The go-to-market plan is `docs/gtm/UK_GTM_PLAN.md` (Appendix 1 of this contract, with the pilot plan in Appendix 2). It is a living document, and it changes by pull request.

## 42. Beachhead and trade shortlist (provisional until Dan confirms)

**Beachhead customer:** owner-run UK service businesses with 1–9 staff, where the owner is usually on a job and can't reply in time. Sole traders are a later, self-serve segment, not the first target. This is a judgement, not a measured fact. The pilot phase exists to test it.

**First five trades for the labelled corpus and the vertical packs (provisional):**
1. Drainage
2. Roofing
3. Locksmiths
4. Garage doors
5. Landscaping and driveways

**Held in reserve:** pest control, appliance repair (excluding gas appliances).
**Excluded until a human approves, with `regulated: true` (§9):** gas, heating and electrical work, and anything else with a statutory competence scheme.

Rules for Claude Code:
- Each trade is a vertical pack (§9). Intents, slots, eligibility rules, pricing schema, templates and 20 corpus cases per trade, so 100 in total.
- Before a pack goes live, a human confirms in an ADR that the conversation itself isn't a regulated activity for that trade. Claude Code lists the open questions, and doesn't answer them.
- Emergency trades (drainage and locksmiths) need extra handling that the pack must carry: an urgency flag, a vulnerable-customer check, a safety-first reply for risk to life or property that tells the person to call emergency services, and no quote or price promise by model wording.
- Pricing for these trades is often by quote. The pack must support "price on inspection" as a valid, grounded answer, so the system never invents a price.

## 43. Product requirements that come from the go-to-market plan
Only Tiers A and B are enabled (D3). These requirements are inbound or opt-in by design:
- **Waitlist and demo request form** with unticked, separate consent boxes per channel (email and SMS asked separately), the sender named, a privacy notice link, and a record of when and how consent was given (§17.2).
- **Missed-enquiry calculator** (a web page). The inputs are used only to show the result. Contact details are collected only if the visitor opts in, and the calculator never presents unsourced statistics.
- **Referral and partner tracking:** a partner (web designer, bookkeeper, supplier, trade body) has a code. Attribution is recorded as provenance (§17.2). No partner receives personal data about a referred business without that business's consent.
- **Networking follow-up capture:** a QR code or short form for people met in person. A business card or a conversation isn't consent to marketing email or text. Follow-up marketing messages are sent only to people who have opted in through the form.
- **Pilot mode:** a tenant flag that forces assist mode, turns on extra measurement, records the pilot agreement version and the DPA version, and produces the pilot report (response times, enquiries handled, owner time, unknowns raised).
- **Consent ledger fields** record the subscriber type where known (company, or sole trader or partnership), and the code treats "unknown" as an individual (§17.2, test F11).
- **Source registry entries** for each inbound channel used in the plan (website, calculator, networking form, referral, partner, social post enquiry, directory listing), each with its lawful basis and notice method.
- **Claims register:** every statistic or claim used in marketing or in the product copy is stored with its source, its date and a status (verified, vendor-reported, or an own measurement). Claims that aren't verified or measured can't be published by the system.
- **Trust page** generated from release evidence (§36.5), with no claim that the system can't prove.

## 44. Open decisions after v1.4 (owner: Dan)
1. Confirm or change the first-five trade list in §42 and the beachhead.
2. The monthly price and pilot terms.
3. Whether Veylith needs ICO registration and a data protection fee as a controller for its own marketing and customers (counsel or ICO self-assessment).
4. All items still open in §40.

---
---

# PART E — Pilot market, pricing and outreach requirements (added in v1.5)

Part E overrides Parts A–D wherever they conflict, except §3 and §8.3.

## 45. Pilot market and status of decisions
- **Pilot market: Ellesmere Port** (decided by Dan, 12 Oct 2026). The overflow catchment is Chester and the Wirral, used only if Ellesmere Port doesn't produce enough qualified pilots.
- **Trade shortlist stays provisional** (§42). Claude Code builds the five packs, but nothing goes live in a trade until the ADR in §42 is approved.
- Appendix 1 (go-to-market plan) and Appendix 2 (pilot pricing and outreach plan) are part of this contract. They're binding on the product where Part E and Part D say so, and are otherwise context. Their prices, dates, targets and scripts are **proposals and hypotheses**, not requirements.

## 46. Pilot operations the product must support
- **Pilot agreement tracking:** the tenant record stores the pilot agreement version, the DPA version, start and end dates, the assist-mode lock, the status of the case-study consent (separate opt-in, off by default) and per-tenant-learning consent (off by default during a pilot).
- **Pilot lifecycle states** (config on the lifecycle engine, §16): `interested` → `qualified` → `agreement_signed` → `knowledge_interview` → `shadow` → `activation_approved` (**human**, §8.3) → `assist_live` → `review` → `founding` or `exit`.
- **Qualification record:** the scorecard fields in Appendix 2 §4 (catchment, trade, size, enquiry sources, pain, digital basics, attitude), stored as typed data with the source and date. The score only prioritises human attention. It never rejects anyone automatically (Art. 22, §17.2).
- **Weekly pilot report** generated from reply records (§10.2): time to acknowledgement, enquiries received and handled, drafts approved, edited and rejected, unknowns, owner minutes per enquiry, grounding blocks, complaints, opt-outs. It goes to the owner, and it's the evidence base for the baseline (§10.3).
- **End-of-pilot price questions:** a structured form (four questions in Appendix 2 §3.3) stored as `human_inputs` with a consumer (the pricing decision note), not as free text.
- **Exit path:** export and erasure per §21.1 are testable in pilot mode (T-ONB, F20, F21).
- **Customer-facing disclosure:** the first reply to a tenant's customer carries the tenant's privacy notice link and an AI-drafted disclosure, as the tenant's policy or counsel requires (§8.4).

## 47. Pricing as data
- Plans, prices, currency, tax treatment, allowances (enquiries, channels, seats), overage rules, effective dates and the **founding-rate lock** (rate and the end date) are versioned data. Changing a price is a data change with an approval record. It's never a code change.
- Prices shown in the product, on the trust page and in invoices come from this data, and the system doesn't hard-code any price.
- Pilot and founding terms are stored on the tenant and honoured automatically by billing (§19.4). A tenant on a locked rate keeps it until the lock ends, even if the list price changes.
- Billing never reads message content (§19.4). Usage counters are the only inputs.
- Founding-rate and pilot terms can only be set or changed by a human with the right role (§8.3: financial exposure and activation).
- **Cost model:** the metrics layer (§10.3) reports cost per tenant and cost per resolved enquiry (compute, SMS, email, number rental, payment fees), so the cost floor in Appendix 2 §1 is measured and not estimated.
- **CONFIRMED by Dan, 12 Oct 2026 (full specification in §49–§51):** a **telephony event adapter** (§9, channel adapters). A missed or unanswered call produces an event with the caller's number and time, and the system sends an automatic text reply to the caller (a response to their own contact, not marketing). No call audio, no recording, no voice AI. It needs a telephony provider, which requires an ADR, an allowlist entry and a register entry before any code is merged (§29). Until Dan confirms, build only the interface and a fake.

## 48. Open decisions after v1.5 (owner: Dan)
1. Accept or change the pilot offer: £0 for 8 weeks, then the founding rate of £59 a month, ex VAT where applicable (Appendix 2 §3).
2. ~~Cost-floor inputs~~ Entered in Part G (§52). Still unknown: real backup cost, an insurance quote, carrier fees, Dan's real time value and budget cap, actual capacity.
3. ~~Confirm the telephony event adapter~~ Confirmed (§49–§51). Open: telephony provider choice (ADR) and counsel review of the missed-call text.
4. How many pilots can run at once, and the weekly hours for recruitment.
5. Confirm or change the first-five trade list (§42).
6. All items still open in §40 and §44.

---
---

# PART F — Missed-call text adapter (added in v1.6)

Part F overrides Parts A–E wherever they conflict, except §3 and §8.3.

## 49. Purpose and scope
When a call to a tenant's business number goes unanswered, the system sends the caller one short, deterministic text reply that invites them to send the enquiry in writing. This closes the biggest gap in version one (no voice) without recording, transcribing or answering calls.

In scope: call events (caller number, called number, time, outcome), one outbound text per qualifying missed call, and handling of the caller's reply as a normal inbound message (§5.2).
Out of scope: call audio, recording, transcription, voicemail processing, voice AI, outbound calls, IVR menus. Any of these needs its own contract and counsel review.

## 50. Requirements

### 50.1 Architecture
- A `TelephonyEventChannel` adapter implements the channel interface (§9): `receive` (verified provider webhook for a call event), `send` (text only), `capabilities`, `consentModel`. It declares its egress hosts, which must be on the allowlist and the register before use (§29).
- **Provider:** chosen by ADR (§29). The ADR must cover: UK number hosting or conditional call forwarding on no-answer, how the caller experiences the call (the contract forbids playing any synthesised or recorded speech beyond the provider's plain ring or busy tone), delivery receipts, sender ID rules, UK/EU data location, DPA and sub-processors, call-metadata retention at the provider, and cost per message and per number. Until Dan approves the ADR, only the interface and a fake provider exist.
- The adapter produces an `unanswered_call` event: `{tenant_id, region, called_number, caller_number (encrypted, blind-indexed), started_at, ring_seconds, outcome}`. Call audio is never requested, received or stored. The adapter rejects any payload that contains audio or a recording URL (test F40).
- The text goes through the normal pipeline: suppression, rate caps and the autonomy policy. It is an `ack`-class message (§7.2).

### 50.2 When a text is sent (all conditions must hold)
1. The tenant has the feature switched on (default **off**), and the tenant's `missed_call_text` policy has been approved by a human (§8.3), because it's a consequential outbound send on the tenant's behalf. It also needs the counsel sign-off recorded in the region rule pack (§8.4).
2. The outcome is unanswered, busy or rejected by the tenant, not answered by someone else, and the call lasted longer than the configured minimum ring time.
3. The caller number is a valid UK mobile number (a number type the provider confirms can receive text). Landlines, premium-rate, withheld, international and non-geographic numbers get no text. A withheld or non-textable caller creates an owner task, not a message.
4. The number isn't on the tenant's or the cell's suppression list (§17.2), and hasn't been texted by this tenant within the cool-down (default 24 hours, config) except where the caller has since replied.
5. The number isn't on the tenant's `known_numbers` list (family, staff, suppliers, the tenant's own devices), where the owner has marked it as no-text.
6. The number passes an abuse screen: per-number and per-tenant rate caps per hour and per day (config), and a stop list for numbers that repeatedly call and never reply (config). Hitting a cap raises a human alert (a possible spam or attack).
7. The time is inside the tenant's permitted sending window (config; default 07:30–21:30 local), with the text queued to the next window start where outside it, unless the tenant has set a different window.
8. The tenant's privacy notice link and opt-out wording are present in the template.

### 50.3 Message content (deterministic, no model wording)
- The text comes from a versioned template. Default wording (the tenant can edit it within the grounding rules, and counsel reviews it):
  > Hi, this is [Business name]. Sorry we missed your call. To help us reply quickly, please text your name, what you need and your postcode, or use [link]. We'll get back to you by [owner's stated time]. Reply STOP to opt out. Privacy: [link]
- Every value comes from tenant records (business name, link, reply time). The grounding check (§5, F3) applies. A missing value means no send and an owner task.
- The text states the business name and can say the reply is automatic. It never contains an offer, promotion, price, availability, a claim of what the business will do, or any marketing content. Marketing language is blocked by a lint on templates (test F38). It is a service reply to the caller's own contact, and it isn't marketing, so it must stay that way.
- One message per qualifying call. No follow-up reminders in this adapter.
- STOP, STOPALL, UNSUBSCRIBE and similar replies add the number to the suppression list immediately, and take effect before any further send (F9).

### 50.4 Handling the caller's reply
- The reply is an inbound message on the normal pipeline (§5.2), and the lifecycle engine (§16) starts or continues the contact's record with `source = missed_call_text`, basis recorded per the counsel-approved position.
- A reply is **not consent to marketing** (§17.2). It only permits the conversation about the enquiry.
- If the reply gives a name, job and postcode, the deterministic core handles it (§5.3). Unclear content goes to the owner as an UNKNOWN.
- Emergency or safety content in a reply triggers the safety-first handling in §42 for emergency trades.

### 50.5 Data protection
- Caller numbers are personal data. Category `contact` in the erasure registry (§6.4), encrypted at rest (§6.3), and retained for the shortest period counsel confirms. Call events with no reply and no enquiry are deleted or anonymised after the retention period (default 30 days, config).
- The tenant is the controller for the caller's data, and Veylith is the processor (§21.2). The telephony provider is a sub-processor and goes on the register (§26).
- The data processing agreement and the privacy notice must state that missed-call numbers are processed to send the reply. The tenant's customers get this information through the text's privacy link.
- A DPIA entry covers the feature (§34 pattern), and counsel confirms the lawful basis and the PECR position before it's enabled for any tenant. I haven't verified either.
- The feature never reads, requests or stores audio. A test (F40) fails the build if any code path touches audio fields.

### 50.6 Measurement
Reply records (§10.2) add: time from call end to text sent, delivery status, whether the caller replied, time to the first reply, whether an enquiry resulted, opt-outs, and complaints. Metrics (§10.3): missed calls, texts sent, reply rate, enquiry conversion, opt-out rate, and suppression events. The **speed target** for this feature starts at **60 seconds from the end of the call to the text being accepted by the provider** (to be confirmed by Dan, and recorded in the baseline), measured under F7-style load.

### 50.7 Tests (written first, shown red)
- **F37** a text is sent only when every condition in §50.2 holds, and each condition has a failing case that blocks it.
- **F38** template lint: no marketing, price, offer or unsourced value, and a missing value blocks the send.
- **F39** suppression and STOP: an opt-out arriving at the same moment as a send always wins (race test), and the number is never texted again.
- **F40** no audio: a payload with audio or a recording URL is rejected, and no audio field exists in the schema.
- **F41** rate caps and the abuse screen: a flood of calls from one number or many numbers triggers the caps and an alert, and never an unbounded send.
- **F42** idempotency: replaying the same call webhook twice results in one text.
- **F43** isolation: tenant A's call events and numbers are invisible to tenant B (F1 pattern), and a number texted by A is not revealed to B.
- **F44** erasure: deleting a contact removes the caller number, the call events and any blind index, including at the provider where the API allows it, and the certificate lists what the provider holds.
- **F45** timing: the speed target in §50.6 under 20 concurrent calls.

## 51. Phase and gates
- **Phase 9b** (after Phase 4, because it needs the acknowledgement path and grounding): the adapter interface, the fake provider, templates, and tests F37–F45 written red then green against the fake.
- **Real provider integration** only after: the provider ADR is approved by Dan, the provider is on the allowlist and the register, counsel has signed off the lawful basis and the PECR position, the DPIA entry exists and the first tenant's `missed_call_text` policy has been approved by a human.
- **Pilot use:** off by default for every pilot. It's enabled per pilot only after a human approves it in the pilot agreement. The pilot plan records the caller-facing wording version.

---
---

# PART G — Capacity and cost-floor model (added in v1.7)

Part G overrides Parts A–F wherever they conflict, except §3 and §8.3. Every figure marked H is a **hypothesis** that the product must replace with measured values. Nothing marked H is a decision.

## 52. Inputs and status

| Input | Value | Status |
|---|---|---|
| VPS (16GB) | £10.80 a month | S, stated by Dan |
| Email (Gmail) | £0 | S, stated by Dan |
| Backups | £3.00 a month | H |
| Insurance (professional indemnity and cyber, "from" prices) | £17.56 a month | P, needs a real quote |
| **Fixed cash cost (base)** | **£31.36 a month** | derived |
| Twilio UK outbound SMS | $0.056 a segment, about £0.042 | P |
| Twilio UK inbound SMS | $0.0075 a segment, about £0.0057 | P |
| Twilio UK mobile number | $2.50 a month, about £1.89 | P |
| Twilio inbound call minute | $0.01 a minute, about £0.0076 | P |
| Stripe UK cards (Veylith's own billing) | 1.5% + 20p standard, 2.8% + 20p premium | P, provider not yet chosen |
| FX | £0.756 per $1 (12 Oct 2026) | P, recheck |
| Pilot capacity | 3 concurrent to start, 5 at most | H |
| Dan's hours | 12 a week (8 support, 4 recruitment) | H |
| Hours per pilot | About 20 over 8 weeks | H |
| Value of Dan's hour | £25 | H |
| Pilot budget cap | £250 cash | H |

Published prices were read on 12 October 2026 from [Twilio SMS](https://www.twilio.com/en-us/sms/pricing/gb), [Twilio voice](https://www.twilio.com/en-us/voice/pricing/gb), [Stripe](https://stripe.com:80/gb/pricing), [Simply Business](https://www.simplybusiness.co.uk/business-insurance/professional-indemnity-insurance/) and [PolicyBee](https://www.policybee.co.uk/sole-trader-insurance). Twilio says carrier fees may apply and doesn't state them, so they're an UNKNOWN. Twilio bills SMS per segment, and the default missed-call template in §50.3 is likely to need two segments, so the model counts two.

## 53. What the numbers say (model, not forecast)

Assumed monthly use per tenant (H): low = 10 missed-call texts, 40 other outbound segments, 25 inbound segments, 20 call minutes; base = 20, 100, 50, 40; high = 40, 250, 120, 100.

| Scenario | Messaging and numbers cost per tenant per month |
|---|---|
| Low | about £4.72 |
| Base | about £8.40 |
| High | about £17.30 |

- **Cash margin at the proposed £59 founding rate** (base use, Stripe at the standard rate): about £49 per tenant per month. Fixed cash cost of £31.36 is covered by one paying tenant.
- **Time is the real cost.** At £25 an hour (H), the margin at £59 is about £36.60 at 0.5 support hours per tenant per month, £24.10 at 1 hour, and about zero at 2 hours. Break-even price at 2 hours a month is about £60.
- **Pilot cash cost:** about £108 for 3 pilots and £138 for 5 over two months, inside the £250 cap (H). The time cost is about 60 hours for 3 pilots and 100 hours for 5, which is £1,500 and £2,500 at £25 an hour.
- **Capacity potential once built:** if operator time stays at or below 1 hour per tenant per month, the same 8 hours a week of support could carry about 30 tenants, which is a design goal and not a prediction. Start with 3, move to 5 only when pilot support hours per week are measured and stay inside the budget.
- **Price context:** [published UK trades tools run from about £39 to £99 a month](https://www.shoogly.co.uk/ai-receptionist-cost-uk), so £59 is inside the market band. The pilot should test whether a lower support burden or a higher price is needed.

Flags:
- **Gmail:** the figure £0 is accepted, but automated tenant-facing email through a Gmail account may hit sending limits and terms, and Google would be a processor that must go on the register. I haven't verified Gmail's limits. The email provider ADR (§29) must cover this before email sending goes live.
- **Twilio:** Dan chose Twilio for SMS and telephony. It still needs the provider ADR (§29): DPA, sub-processors, data location, UK sender and number rules, delivery receipts, retention, and the allowlist and register entries. No Twilio code is merged until Dan approves the ADR.
- **Insurance:** the "from" prices cover small amounts and may not fit Sevari's risk. Get a quote that names the activity (AI-assisted business communications and data processing) before any pilot starts.

## 54. Requirements from the model
- **Cost model as data:** every input in §52 is a row in a `cost_inputs` table with `value`, `unit`, `status` (stated, published, hypothetical, measured), `source`, `checked_on` and `expires_on` (published prices expire after 90 days and raise a task to recheck). The metrics views (§10.3) use measured values when they exist and the hypothetical ones otherwise, and label which.
- **Per-tenant cost view:** compute, messaging, number rental, payment fees, and **operator minutes** (Dan's time) per tenant per month. The operator time comes from a lightweight time log in the owner console, which Dan records for pilot support and which the system never infers.
- **New ops metrics:** operator minutes per tenant per month, cash margin per tenant, margin after operator time, and the break-even price. The weekly report to Dan flags any tenant where operator time exceeds the configured limit (default 60 minutes a month after the pilot).
- **Capacity guard:** a pilot capacity setting (default 3, maximum 5 until Dan changes it) that stops a new pilot from moving past `agreement_signed` while the cap is reached, and raises an owner task instead.
- **Budget guard:** a pilot budget cap (default £250 cash) with an alert at 80 percent. Reaching it freezes new pilot onboarding, and doesn't stop live pilots.
- **Replace assumptions:** the first baseline report (§10.3) must list every H value replaced by a measured one and every H value that remains.

## 55. Open decisions after v1.7 (owner: Dan)
1. Real figures for backups, insurance (a quote), Dan's time value and the cash cap. Until then the H values stand.
2. The Twilio ADR items are now specified in §57 (checklist). Open: the answers, the carrier fees, and whether number type and sender ID fit the missed-call text.
3. Email provider for tenant-facing mail (the Gmail flag).
4. The Stripe or alternative provider ADR for Veylith's own subscription billing.
5. Items still open in §40, §44, §48.

---
---

# PART H — Build checklist and Twilio provider ADR requirements (added in v1.8)

Part H overrides Parts A–G wherever they conflict, except §3 and §8.3. A box is ticked only when the evidence named beside it exists in the repository or in `docs/adr/`. Claude Code never ticks a box on assumption, and Dan or counsel tick the boxes marked (Dan) or (Counsel).

## 56. Build checklist

### 56.1 Gates that apply to every provider (from §12, §26, §29)
- [ ] ADR file exists at `docs/adr/providers/<category>-<provider>.md`, with licence or terms, DPA, sub-processors, data location, transfer mechanism, breach terms, export and deletion, swap cost, and any authorisation Sevari would need
- [ ] Every claim in the ADR carries a source link and a date, and anything unverified is listed as an UNKNOWN for Dan
- [ ] Dan has approved the ADR in writing (Dan)
- [ ] Hosts are in `config/egress.allowlist.yaml`, and F2 passes with them
- [ ] The processor register is regenerated from the allowlist and shows the provider
- [ ] A fake provider and recorded fixtures exist, and all adapter tests pass against the fake before any real call
- [ ] The real provider is behind a per-cell feature flag, off by default
- [ ] `cost_inputs` rows exist for every price the provider charges, with a source and an expiry (§54)
- [ ] The provider's sub-processor change notices go to a mailbox someone reads, and a task is raised on each change
- [ ] The tenant-facing sub-processor list and the DPA template are updated

### 56.2 Phase gates (from §11, §25, §38, §51)
- [ ] Phase 0: repo, CI, lint rules, gitleaks, every F and T test written and red
- [ ] Phase 1: schema, region, RLS, boot guard, audit chain, crypto envelope (F1, F4, T-BOOT, T-AUD green)
- [ ] Phase 2: intake, auth, tenancy, egress client, allowlist, register generator (F2 green)
- [ ] Phase 3: deterministic core and baseline on the corpus
- [ ] Phase 4: acknowledgement path and grounding (F3, F7 green)
- [ ] Phase 9b: telephony event adapter against the fake (F37–F45 green)
- [ ] Provider ADRs approved before any real integration (§29, §56.1, §57)
- [ ] Phase 18: human-input layer green (F22–F27) before Phase 6 closes
- [ ] Every PR report includes the items in §13 and §39

## 57. Twilio provider ADR requirements

*Draft answers to every section below are in Part I (§59), with the new requirements they create in §60. Answers aren't approvals, so the boxes stay unticked until the ADR is approved.*

File: `docs/adr/providers/telephony-sms-twilio.md`. Dan chose Twilio on 12 October 2026, so the ADR records that decision and doesn't re-run a three-way selection. It must still name at least two alternatives and the swap cost, so replacing Twilio later is a port and an adapter change, not a rewrite. The ADR must answer every item below with evidence. Facts I checked on 12 October 2026 are given with sources as starting points. Claude Code must verify each one again, because Twilio's terms and docs change.

### 57.1 Scope of use
- [ ] The ADR lists the exact Twilio products used: Programmable Messaging (SMS), phone numbers, and Programmable Voice limited to call events and status callbacks
- [ ] The ADR lists the Twilio features that are **forbidden** in this contract and confirms each is off or unused: call recording, transcription, voice intelligence, voice AI or speech features, Studio, Flex, Conversations, any AI feature, and any product that stores call audio. Any later use needs a new ADR and a contract amendment (§49 scope)
- [ ] The ADR states how the adapter rejects audio and recording fields (test F40)
- [ ] Email through Twilio SendGrid and any other Twilio product are out of scope and need a separate ADR

### 57.2 Account structure and security
- [ ] The Twilio account is in Veylith Systems' name, with a named owner and two-factor authentication on every console user
- [ ] One subaccount per tenant (or a documented alternative) so usage, numbers, keys and logs are separated per tenant, and so a tenant's exit means closing its subaccount (F1 pattern, F44)
- [ ] API keys, not the main auth token, are used by the application, with the least privilege Twilio allows, stored in the in-region secrets manager (§36.3) and rotated on a schedule with a test
- [ ] Webhooks validate Twilio's request signature, and unsigned or mismatched requests are rejected (test)
- [ ] Idempotency uses Twilio's message and call identifiers, so replayed webhooks give one effect (F42)
- [ ] Usage and spend alerts and a hard monthly cap are configured per account, and the cap is recorded in `cost_inputs`
- [ ] Console and API audit logs are reviewed, and access follows the just-in-time rule in §36.3

### 57.3 Data location, regions and transfers
- [ ] The ADR states where each data type is processed and stored: message body, caller and recipient numbers, call metadata, delivery logs, billing data, support access
- [ ] Twilio offers [SMS data residency in its Ireland (IE1) region](https://www.twilio.com/docs/global-infrastructure/sms-eu-data-residency), and message personal data is stored and processed in the EU up to the point it reaches Twilio's connections with telecoms providers. Telecoms providers may store and process data outside the EU under their own policies, and Twilio personnel outside the EU may access data for support. The ADR must say whether this is acceptable for the UK cell and what the tenant-facing notice says
- [ ] The Twilio docs state that [during the initial phase of its Regions rollout, Twilio does not guarantee that all data will remain within the selected Region](https://www.twilio.com/docs/global-infrastructure). The ADR must check whether this still applies to each product used, and record the answer
- [ ] **The UK cell and IE1:** the UK cell would send personal data to an EU region. The contract says data stays in its region and cross-region writes need a `region_transfer_contract` row (§1, INV-2). The ADR must propose how this is modelled (for example, a recorded transfer contract from `uk` to `ie1` for SMS data only), and whether UK to EU transfers are treated as adequate under UK law (Counsel). **No Twilio traffic is allowed from the UK cell until this is decided and recorded (Counsel, Dan)**
- [ ] The ADR confirms how to pin the regional API base URL, and the allowlist holds only the hosts needed for that region (for example the IE1 base URL that Twilio documents)
- [ ] The default (non-IE1) processing region is blocked in the egress allowlist, with a test (F2) that a call to a non-pinned Twilio host fails
- [ ] Phone numbers used as senders are not personal data under Twilio's docs, but callers' and recipients' numbers are, and are treated that way in the registry

### 57.4 Contract, DPA and roles
- [ ] Twilio's [Data Protection Addendum](https://www.twilio.com/en-us/legal/data-protection-addendum) is accepted and the executed copy is stored
- [ ] Roles are recorded: the tenant is the controller, Veylith is the processor, Twilio is a sub-processor (§21.2)
- [ ] The DPA's sub-processing terms are summarised: general authorisation for sub-processors, a published list, notification of changes (the DPA says at least 30 days for infrastructure providers and at least 10 days for others, which the ADR must re-verify), and the right to object
- [ ] The transfer mechanism for onward transfers from the UK is recorded. The DPA refers to the UK International Data Transfer Agreement where the destination isn't adequate and isn't covered by Twilio's binding corporate rules, and to Twilio's [transfer impact assessment](https://help.twilio.com/articles/4407117654555-Transfer-Impact-Assessment-Twilio-s-Onward-Data-Transfers) (Counsel confirms)
- [ ] The breach-notification terms and timings are recorded and mapped to the 72-hour workflow (§36.4)
- [ ] The tenant DPA and the tenant sub-processor list are updated to include Twilio, and tenants are told of changes in line with their DPA
- [ ] Twilio's acceptable-use and messaging policies are read, and the missed-call text use case is confirmed to be allowed. The ADR records any limit that affects it

### 57.5 Numbers and UK regulation
- [ ] The ADR confirms the plan to use UK mobile numbers, whose price I read as [$2.50 a month](https://www.twilio.com/en-us/voice/pricing/gb), and records the price in `cost_inputs`
- [ ] Twilio requires an approved regulatory bundle for UK long-code numbers, and the numbers must be assigned to that bundle and an address. Twilio's UK guidelines list, for businesses, a valid UK business address and, for individuals, proof of address, and the FAQ says it can't accept a PO box or a virtual address as proof of local address ([Twilio UK regulatory guidelines](https://www.twilio.com/en-us/guidelines/gb/regulatory), [UK KYC framework](https://help.twilio.com/articles/21038555454875), [regulatory FAQ](https://www.twilio.com/docs/phone-numbers/regulatory/faq)). The ADR must say whose name each bundle is in (Veylith, or each tenant), what documents are needed, and how long approval takes
- [ ] The ADR states who is the "customer" of record for a tenant's number, and how that affects the tenant's exit and number porting
- [ ] Number strategy is decided and justified: a number per tenant, or a shared number with the tenant named in the text. The ADR covers how callers recognise the sender and how replies are routed to the right tenant (F43)
- [ ] The ADR covers **call detection**: how an unanswered call becomes an event (for example, conditional forwarding of unanswered calls to a Twilio number, or porting the tenant's number), what the caller hears (only plain ring or busy tone, never recorded or synthesised speech, §50.1), what the tenant must configure on their phone line, and what happens to the call if Twilio is unreachable
- [ ] Emergency-address and voice rules for UK numbers are read, and the ADR confirms what applies when voice is used only for inbound call events
- [ ] Sender ID: the ADR states that replies need a number rather than an alphanumeric ID, whether any UK sender-ID registration applies, and which sender type the missed-call text uses
- [ ] Opt-out: the ADR records whether Twilio handles opt-out keywords on the chosen UK number type, and confirms that Sevari's suppression list is the single source of truth either way (F39). Replies of STOP are suppressed in our database before any further send
- [ ] Ofcom and ICO rules that apply to the number and the text are listed as UNKNOWNs for Counsel where Claude Code can't evidence them

### 57.6 Retention, erasure and export
- [ ] The ADR states Twilio's default retention for message bodies, message logs, call logs and recordings, and which of these can be deleted or redacted through the API
- [ ] The ADR sets Sevari's retention (§50.5), and a test (F44) shows that erasing a contact deletes or redacts the data at Twilio where the API allows, and lists what Twilio keeps and for how long, so the erasure certificate is accurate
- [ ] Message bodies are redacted or deleted at Twilio after delivery where Twilio permits it, and Sevari keeps its own encrypted copy (§6.3)
- [ ] Exit: the ADR describes how to export logs, close subaccounts, release or port numbers and prove deletion at the end of a tenant contract

### 57.7 Technical design and failure modes
- [ ] The adapter implements the channel interface (§9, §50.1), with a fake provider and recorded fixtures for send, delivery receipts, inbound SMS, call status and errors
- [ ] SMS **segments** are counted by encoding: the ADR states how a message is split (for example, 160 characters for GSM-7 text and fewer when non-GSM characters appear) and checks the default template in §50.3, because Twilio bills per segment. A test (F38) fails any template that would exceed the configured segment cap
- [ ] Delivery statuses are mapped to the reply record (§50.6), including failed, undelivered and unknown, and a failed send never causes an unbounded retry
- [ ] Rate limits and throughput limits are recorded, and F41 tests behaviour at and beyond them
- [ ] Failure modes are listed and tested: Twilio outage (queue, alert, no duplicate send), webhook delay, duplicate webhooks, out-of-order status callbacks, number suspended, bundle rejected, spend cap reached
- [ ] The ADR lists every Twilio hostname the code calls and every inbound webhook source, and says how inbound webhook traffic is restricted at the VPS firewall (§36.3) given that Twilio's source addresses may need checking
- [ ] Timing: the call-end-to-text time is measured against the 60-second target under F45

### 57.8 Cost
- [ ] Prices are read from Twilio's pricing pages on the date of the ADR, with the exchange rate: [outbound SMS $0.056 a segment](https://www.twilio.com/en-us/sms/pricing/gb), inbound $0.0075, UK mobile number $2.50 a month, inbound call $0.01 a minute, as read on 12 October 2026
- [ ] **Carrier fees:** Twilio's UK SMS page says additional carrier fees may apply but gives no amounts. The ADR must find the actual fees from Twilio (console, invoice or support) and update `cost_inputs`
- [ ] Any extra charge for IE1 data residency, regional numbers, regulatory bundles, number porting or support is identified
- [ ] The cost model in §53 is re-run with the confirmed figures and the result is attached to the ADR

### 57.9 Compliance
- [ ] A DPIA entry for the missed-call text exists (§50.5, §34 pattern) (Counsel)
- [ ] The lawful basis and the PECR position for the missed-call text are confirmed in writing, including that the message is a service reply to the caller's own call and not marketing (Counsel)
- [ ] The tenant privacy notice wording, the text template wording and the AI-disclosure wording are approved (Counsel, Dan)
- [ ] The record of processing and the processor register include Twilio, with data categories, locations, retention and transfer mechanism
- [ ] The region rule pack for the UK records the counsel sign-off and an expiry (§8.4)

### 57.10 Alternatives and swap
- [ ] At least two alternative providers are named with a short note on price, data location and UK number support, so the swap cost is real
- [ ] The port interface and the adapter boundary are documented, with what would change if Twilio were replaced
- [ ] The ADR states which data would have to be exported or migrated, including number porting rules

### 57.11 Approval
- [ ] Dan approves the ADR (Dan)
- [ ] Counsel confirms the items marked (Counsel), or Dan records them as open risks with a date
- [ ] The allowlist change, the register update and the feature flag change are in separate, reviewed commits
- [ ] The first real message is sent only from a test number to Dan's own phone, with the result recorded before any pilot tenant is connected

## 58. Open decisions after v1.8 (owner: Dan)
1. The UK cell and Twilio's Ireland region: accept IE1 for SMS with a recorded UK to EU transfer, or choose another route (Counsel).
2. Whether the Twilio account and the regulatory bundles will be in Veylith's name or each tenant's.
3. Number strategy: one number per tenant, or a shared number.
4. All items still open in §40, §44, §48 and §55.

---
---

# PART I — Twilio ADR draft answers (added in v1.9)

Part I overrides Parts A–H wherever they conflict, except §3 and §8.3.

These are **researched inputs** for the ADR in §57, gathered on 12 October 2026 from Twilio's own documentation. They aren't the approved ADR. **No box in §57 is ticked by this part**, because a box needs the ADR file in the repository and Dan's approval (§56.1). Claude Code re-verifies every answer when it writes the ADR, because Twilio's pages change.

Status key: **ANSWERED** (evidence found), **PARTIAL** (evidence found, something is still to check), **OPEN** (no evidence yet), **DECISION** (Dan or Counsel must decide).

## 59. Answers by checklist section

### 59.1 Scope (§57.1): ANSWERED, with one check
- Products: Programmable Messaging (SMS), phone numbers, and Programmable Voice used only for call status events. Twilio's call resource shows that [recording defaults to false](https://www.twilio.com/docs/voice/api/call-resource), so no recording happens unless the code asks for it.
- Forbidden features stay forbidden (§57.1). Recording, transcription, Studio, Flex and any AI feature aren't used.
- **Check:** confirm no account-level recording, transcription or voice-intelligence setting is switched on in the console.

### 59.2 Account structure and security (§57.2): PARTIAL
- **Subaccounts:** [a subaccount's credentials can't reach the main account or other subaccounts, and main-account API keys can't reach subaccount resources](https://static0.twilio.com/docs/iam/api/subaccounts). So one subaccount per tenant gives real separation and a clean exit. **Answer: yes, one subaccount per tenant.**
- **Keys:** [API keys are the preferred way to authenticate to the REST API, and Restricted keys give least-privilege access](https://www.twilio.com/docs/iam/api-keys). Use Restricted keys per subaccount, limited to Messaging and the specific resources needed. A Main key is needed to create subaccounts, so keep it out of the application and use it only in a provisioning job.
- **Webhook signatures:** [Twilio signs every webhook with `X-Twilio-Signature`, an HMAC-SHA1 using the account auth token](https://www.twilio.com/docs/usage/webhooks/webhooks-security), and recommends the SDK validator. **This means the auth token of each subaccount is still needed on the server to validate webhooks.** Store each one in the in-region secrets manager and rotate it.
- **No replay protection:** the signed material has [no timestamp, nonce or expiry](https://docs.webhook.co/providers/twilio), so a captured valid request can be replayed. The adapter must add its own replay defence: deduplicate on MessageSid and CallSid with a unique constraint (F42), and reject a webhook for an object that is already in a final state.
- **Reverse proxy:** signature validation uses the exact public URL. Behind a proxy the URL has to be reconstructed correctly, and a test must prove that validation is on in every environment (a flag that disables validation must not exist in production builds).
- **Spend control:** [usage triggers notify by email or webhook when a threshold is reached and are checked about once a minute](https://www.twilio.com/docs/usage/api/usage-trigger). **OPEN:** whether Twilio offers a hard spend cap or only alerts. Check the billing model (for example, a prepaid balance with auto-recharge off acts as a cap). Until answered, assume alerts only, and build an automatic send-freeze that triggers on the webhook (F41).

### 59.3 Data location (§57.3): PARTIAL, plus a DECISION
- Twilio's [SMS data residency in Ireland (IE1) is generally available](https://www.twilio.com/en-us/changelog/data-residency-for-sms--eu--is-now-generally-available--ga-). Personal data in SMS (message body and the person's number) is stored and processed in the EU [up to the point it reaches Twilio's connections with telecoms providers](https://www.twilio.com/docs/global-infrastructure/sms-eu-data-residency). Telecoms providers may store and process outside the EU, and non-EU Twilio staff may access data for support.
- IE1 needs its own credentials and its own base URL (Twilio's IE1 guide names `api.dublin.ie1.twilio.com` as an example), and each number's messaging region must be set to IE1. The ADR must record the exact hosts, and the allowlist must hold only those.
- Twilio's global infrastructure page says that [during the initial phase of the Regions rollout it doesn't guarantee that all data stays within the selected Region](https://www.twilio.com/docs/global-infrastructure). **PARTIAL:** check whether that wording is still current for Messaging and Voice.
- **Voice in IE1:** Twilio lists Dublin (IE1) as a home region, but I haven't verified which Voice features and numbers run there. Check, and record, before relying on it for call status events.
- **DECISION (Dan, Counsel):** the UK cell sending data to an EU region needs a recorded transfer (`region_transfer_contract`, INV-2). Whether UK-to-EU transfers need extra safeguards is a question for Counsel. My recommendation to put to Counsel: pin everything to IE1 and record the transfer limited to SMS and call-event data. No traffic from the UK cell until it's decided.

### 59.4 Contract and DPA (§57.4): PARTIAL
- [Twilio's Data Protection Addendum](https://www.twilio.com/en-us/legal/data-protection-addendum) gives general authorisation for sub-processors, publishes a [sub-processor list](https://www.twilio.com/en-us/legal/sub-processors) with a way to subscribe to change notices, and promises notice of changes: not less than 30 days for infrastructure providers and not less than 10 days for other sub-processors.
- For transfers out of the UK to countries without adequacy and outside Twilio's binding corporate rules, the DPA applies the UK International Data Transfer Agreement. Twilio also publishes a [transfer impact assessment](https://help.twilio.com/articles/4407117654555-Transfer-Impact-Assessment-Twilio-s-Onward-Data-Transfers).
- **Actions for Dan:** accept the addendum on the account, store the executed copy, and subscribe the right mailbox to sub-processor change notices.
- **OPEN:** the security-incident notification clause and its timing (I haven't read it). Map it to the 72-hour workflow.
- **OPEN:** acceptable-use and messaging policy check for the missed-call text use case.

### 59.5 Numbers, regulation, opt-out and call detection (§57.5): PARTIAL, with two DECISIONS
- **Regulatory bundle:** [all new UK long-code numbers need an approved regulatory bundle](https://help.twilio.com/articles/21038555454875) and the number has to be assigned to the bundle and an address. [Twilio's UK guidelines](https://www.twilio.com/en-us/guidelines/gb/regulatory) ask for a valid UK address (businesses) or proof of address (individuals), and the [FAQ](https://www.twilio.com/docs/phone-numbers/regulatory/faq) says it can't accept a PO box or virtual address as proof. **OPEN:** approval time, and whether Veylith's bundle can cover numbers sub-assigned to tenants. Twilio's sender-ID registration asks whether you will sub-assign to end customers, which suggests an ISV route exists, but I haven't verified it for numbers.
- **DECISION: bundle ownership.** Recommendation to confirm with Twilio and Counsel: Veylith-owned bundle if Twilio allows sub-assignment, otherwise tenant-owned bundles. This also decides what happens to the number when a tenant leaves.
- **Sender type: answered.** [Alphanumeric sender IDs are supported in the UK but are one-way only, and the STOP keyword doesn't work on them](https://www.twilio.com/docs/numbers-and-senders/alphanumeric-senders). The missed-call text needs the caller to reply, so **it must use a UK mobile number as sender, not an alphanumeric ID.** [Protected sender IDs need a letter of authorisation](https://help.twilio.com/articles/23737742623387-Documents-Required-and-Instructions-to-Register-Your-Alphanumeric-Sender-ID-in-United-Kingdom), which doesn't apply here.
- **Opt-out: answered.** For long codes, [Twilio blocks the recipient on STOP, still passes the STOP message to your webhook, and later sends from that number fail with error 21610](https://help.twilio.com/articles/223134027-Twilio-support-for-opt-out-keywords-SMS-STOP-filtering-). The block applies to the pair of recipient and the Twilio number. A START, YES or UNSTOP reply re-subscribes, and that is also passed to the webhook. Consequences: Sevari's suppression list stays the source of truth (F39). The STOP webhook writes to it before anything else. A START reply from a person is recorded as their own action and allows conversation about their enquiry only, never marketing (§50.4). Twilio's block can't be relied on alone.
- **DECISION: number strategy.** Recommendation: **one number per tenant**, inside that tenant's subaccount. Because Twilio's block is per recipient and number, a STOP to one tenant's number doesn't block another tenant, which matches per-tenant suppression and avoids one tenant's callers seeing another's name. Cost is [$2.50 a month per number (about £1.89)](https://www.twilio.com/en-us/voice/pricing/gb).
- **Call detection: two designs, DECISION.** A call to a Twilio number can end `busy` or `no-answer`, and Twilio posts a [status callback](https://www.twilio.com/docs/voice/twiml) with that status. Calls with those statuses [are not charged](https://help.twilio.com/articles/223132547-What-are-the-Possible-Call-Statuses-and-What-do-They-Mean-).
  - **Design A: bridge.** The tenant's published number is a Twilio number that rings the owner's mobile. Every answered call has two billed legs: inbound at [$0.01 a minute](https://www.twilio.com/en-us/voice/pricing/gb) and outbound to a UK mobile at [$0.0305 a minute](https://www.twilio.com/en-us/voice/pricing/gb), about £0.031 a minute together. Twilio is in the path of every call, so an outage affects answered calls. Highest risk and cost.
  - **Design B: carrier divert on no answer.** The tenant keeps their own number and asks their mobile network to divert **unanswered** calls to the tenant's Twilio number. The Twilio app answers with `<Reject>` as its first verb, which is [not billed](https://www.twilio.com/docs/voice/twiml/reject), and the caller hears a busy or not-in-service tone as their provider decides. Twilio never sees answered calls, so an outage can only lose the text, not a call. Trade-offs: the tenant's own voicemail is replaced by the divert, and each tenant must set up the divert on their line (a codes guide per network is needed, and I haven't verified the UK networks' codes).
  - **Recommendation:** Design B for pilots. It carries no call path risk, no call audio, and lower cost, and it fits the contract's "no voice" boundary. The ADR confirms, and Dan decides.
- **OPEN:** emergency-address obligations for UK numbers when used only for inbound call events.
- **OPEN:** Ofcom and ICO rules on the text itself (Counsel).

### 59.6 Retention, erasure, export (§57.6): PARTIAL
- **Default retention:** [message records and bodies show in the console and API for up to 13 months (400 days) by default, and you can shorten this between 7 and 400 days](https://help.twilio.com/articles/223181008-Twilio-SMS-message-and-traffic-storage). Older records aren't deleted by default and stay in bulk export unless you choose deletion. **Set the shortest retention that works and choose permanent deletion for older records.**
- **Delete:** an HTTP DELETE removes a message from customer-facing logs, and [bodies may persist for up to 30 days in Twilio's backups](https://www.twilio.com/docs/messaging/api/message-resource). **The erasure certificate (F44) must state this 30-day tail.**
- **Redact:** posting an empty body redacts the body but keeps the record. [Message Redaction](https://www.twilio.com/docs/messaging/guides/privacy-message-redaction) can remove bodies and phone numbers from the console, API and Twilio's support tools after sending, with the unredacted data kept for up to 24 hours in production and in limited-access compliance storage. For inbound messages Twilio keeps the whole message while it tries your webhook, so set both primary and fallback webhooks with POST. **OPEN:** whether Message Redaction is a paid or edition feature and what it costs. Twilio's pages list it with [Editions packages](https://www.twilio.com/en-us/blog/products/launches/introducing-new-twilio-editions-packages-companies-scale).
- **Design consequence:** with redaction on, **Sevari's own encrypted copy is the only readable record**, so inbound webhook reliability is a data-loss risk. The adapter must persist the raw inbound message before acknowledging the webhook (§5.2), and must run a fallback webhook.
- **Call logs:** I found no published deletion date for call logs, and one source says they're viewable for 13 months. That source isn't Twilio's, so this is **OPEN**: confirm with Twilio's documentation or support.
- **Recordings:** none are made. If anyone ever creates one, [Twilio keeps it until deleted and keeps its metadata for 40 days after deletion](https://www.twilio.com/docs/voice/api/recording), which is one reason recording is forbidden.
- **Account closure:** one non-Twilio source says data is deleted 30 days after closing an account. **OPEN:** confirm in Twilio's documentation before the exit process (§21.1) relies on it.

### 59.7 Technical design (§57.7): PARTIAL
- **Segments:** [GSM-7 fits 160 characters in one segment and 153 per segment when split, and any non-GSM-7 character switches the whole message to UCS-2 at 70 and 67](https://www.twilio.com/docs/glossary/what-sms-character-limit). I checked the default template in §50.3 with a sample business name: it's about 264 characters, which is **2 segments** in GSM-7 and would be **4 segments** if one curly apostrophe made it UCS-2. So the template must stay in plain GSM-7 characters. Requirement in §60.
- **Delivery statuses, retries and rate limits:** map and test as written (§57.7). **OPEN:** Twilio's throughput limits for UK long codes (check before F41).
- **Webhook source addresses:** [Twilio doesn't publish a list of IP addresses for webhook requests](https://help.twilio.com/articles/223183708-Does-Twilio-have-a-list-of-IP-addresses-which-requests-might-come-from), so the firewall can't restrict webhook sources by IP. A [Static Proxy for Webhooks](https://www.twilio.com/docs/iam/twilio-editions/twilio-static-proxy?pass=1) with fixed ranges (including an IE1 range) exists in Twilio's Security and Enterprise editions. **Answer:** rely on signature validation, replay defence, rate limiting and a tenant-scoped route per webhook. Treat Static Proxy as optional and check its edition and cost.
- **Outbound allowlist (important):** Twilio's API addresses are dynamic, and Twilio recommends allowing outbound HTTPS to its domains rather than IPs. The nftables default-deny plan in §36.3 and Design v4 works on IP addresses. **A plain IP rule can't enforce a hostname allowlist for Twilio.** Requirement in §60: a hostname-aware egress proxy.
- **Failure modes:** list and test as in §57.7. Add the 21610 blocked-recipient error, the bundle-rejected and number-suspended cases.

### 59.8 Cost (§57.8): ANSWERED, with a correction
- Read on 12 October 2026: [outbound SMS $0.056 a segment, inbound $0.0075](https://www.twilio.com/en-us/sms/pricing/gb), [UK mobile number $2.50 a month, inbound call $0.01 a minute, outbound UK mobile $0.0305 a minute and outbound UK landline $0.0158 a minute](https://www.twilio.com/en-us/voice/pricing/gb). Failed messages carry a $0.001 fee.
- **Correction to §53:** the earlier model priced only the inbound minute. Under Design A (bridge), voice cost is about £0.61, £1.22 and £3.06 a month per tenant for low, base and high use. Under Design B (divert and reject) it's about £0. Both are small next to the £59 rate, so the choice rests on risk and customer experience, not cost.
- **OPEN:** carrier fees (Twilio's page says they may apply and gives none), IE1 residency surcharges, bundle or porting fees, Message Redaction and Static Proxy costs.

### 59.9 Compliance (§57.9): OPEN for Counsel
All items stay open: the DPIA entry, the lawful basis and PECR position for the text, the notice and template wording, and the region rule pack sign-off. Claude Code prepares drafts. Counsel decides.

### 59.10 Alternatives (§57.10): OPEN
Claude Code names at least two alternatives for the ADR and checks them from their own documentation. Candidates to evaluate, with no claims made here: Vonage, Sinch, Bird (formerly MessageBird), Telnyx. The port and adapter boundary must make a swap a bounded change.

### 59.11 Approval (§57.11): Dan
Nothing is approved yet.

## 60. Requirements arising from the answers
These override §36.3, §50 and §53 where they conflict.

1. **Hostname-aware egress proxy.** Outbound traffic to named hosts (including Twilio's) goes through a forward proxy that enforces a hostname allowlist, and the VPS firewall allows outbound traffic only to that proxy. The processor register is generated from the proxy's allowlist. Test F2 gains a runtime case: a request to a non-listed hostname through the proxy fails, and a direct connection that bypasses the proxy also fails.
2. **GSM-7 template lint.** Every outbound SMS template is checked at build and at render time: only GSM-7 characters (no curly quotes, emoji or non-GSM symbols), at most 306 characters after substitution (2 segments), and a render that would exceed the cap blocks the send and raises an owner task (F38). The default template is 264 characters with a sample name, so tenant name and reply time must be length-limited.
3. **Webhook defences.** Signature validation with the vendor SDK, with no setting that disables it in production; deduplication on provider identifiers; no processing of webhooks for objects in a final state; a tenant-scoped route; rate limits; and a fallback webhook (F42, F43).
4. **STOP and START handling.** The STOP webhook writes to the suppression list before any other effect. A 21610 error on send also writes to the list. START, YES or UNSTOP permits conversation about the enquiry only (F39).
5. **Retention settings as code.** The provisioning job sets each tenant subaccount's message retention to the shortest value allowed by contract and counsel, and enables redaction if the ADR confirms it is available. Erasure deletes message records through the API and states the provider's 30-day backup tail on the certificate (F44).
6. **Raw inbound persistence.** The inbound message is stored encrypted before the webhook returns success, because with redaction on Twilio's copy may be unreadable (§5.2).
7. **Per-tenant number and subaccount.** The default is one number and one subaccount per tenant, pending the §59.5 decision.
8. **Call-detection design.** The adapter supports Design B first. Design A is allowed only after a new ADR addressing outage impact on answered calls.
9. **Cost inputs.** `cost_inputs` (§54) gains: outbound UK mobile minute, outbound UK landline minute, failed-message fee, and (once known) carrier fees, redaction and Static Proxy costs.
10. **Provisioning job.** A single reviewed job creates the subaccount, restricted keys, number, bundle assignment, regional settings, retention and redaction settings, webhooks and usage triggers, and records each step in the audit log, so no tenant is set up by hand in the console.

## 61. Open decisions after v1.9 (owner: Dan)
1. UK cell and IE1 (Counsel): accept the recorded UK to EU transfer for SMS and call-event data.
2. Bundle ownership: Veylith-owned if Twilio allows sub-assignment, else tenant-owned.
3. Number strategy: one number per tenant (recommended).
4. Call detection: Design B (recommended for pilots) or Design A.
5. Message Redaction and Static Proxy: whether to pay for them if they're edition features.
6. Account actions: accept the Twilio data processing addendum, subscribe to sub-processor notices, set spend alerts.
7. All items still open in §40, §44, §48, §55 and §58.

---
---

# PART J — Definition of finished, value gate, delivery, keys, grounding, processors, recovery, legal precision (added in v1.10)

Part J overrides Parts A–I wherever they conflict, except §3 and §8.3, which it only tightens or clarifies. Source: Dan's amendments of 13 October 2026. The architecture and the existing requirements stay as they are; Part J defines what "finished" means, removes ambiguity and closes reliability gaps.

## 62. What "finished" means: three separate states

| State | Meaning | Who declares it | Evidence |
|---|---|---|---|
| **Build-complete** | Phases 0–8 (and any later phase in scope) have their exit criteria green | Claude Code reports; Dan merges | CI gate, phase reports (§13) |
| **Production-approved** | §63 Production Readiness has passed | **Dan (human, §8.3)** | `docs/readiness/` evidence pack, each item signed off |
| **Commercially launched** | §64 Value Gate has passed | **Dan (human, §8.3)** | `docs/readiness/value-gate.md` with pilot evidence |

Rules:
- Until §63 passes, the system is described everywhere (README, trust page, sales material, reports) as **build-complete, not production-approved**. A passing CI pipeline MUST NOT be presented as evidence that the service is ready for paying customers.
- The prohibition on production deployment (§12) stays until §63 passes. Pilots run under §63's pilot-scope subset only (marked P below).

## 63. Production Readiness phase (new phase "PR")

Each item needs evidence in `docs/readiness/` and a dated human sign-off recorded as a `human_inputs` approval (§30). Items marked **P** are also required before the first pilot.

| # | Item | Evidence required | P |
|---|---|---|---|
| PR-1 | Deployment | Reproducible deployment from the repo to the target box; rollback to the previous release tested | P |
| PR-2 | Recovery | Backup schedule running; a timed restore to a clean box meets the approved RPO/RTO (§70); erasure re-applied after restore (F35) | P |
| PR-3 | Security review | Threat model current (§36.3); key-management boundary documented (§67); external penetration test before the first **paying** tenant | P (threat model, keys) |
| PR-4 | Monitoring | SLO dashboards, alert routes to a person, on-call expectation written down | P |
| PR-5 | Customer onboarding | Tenant onboarding (§18) run end to end on the house tenant and one test tenant | P |
| PR-6 | Support | Support channel, response expectations and escalation path written and tested | P |
| PR-7 | Billing arrangements | Subscription collection works for the plan in use; a manual process is acceptable for pilots (§65) | P (manual) |
| PR-8 | Terms and privacy | Terms of service, DPA, privacy notice, sub-processor list and AI-disclosure wording approved (Counsel, Dan) | P |
| PR-9 | Incident handling | Incident and personal-data-breach assessment workflow (§71) exercised in a drill | P |
| PR-10 | Cancellation, export and erasure | Tenant exit (§21.1) run end to end in a test tenant: notice, export, erasure certificate | P |
| PR-11 | Pilot acceptance | Pilot agreement and success criteria agreed with each pilot before start (§46) | P |

## 64. Value Gate (before wider commercial launch)

Before any commercial launch beyond the pilots, Dan approves this gate on evidence. Failing it means more pilots or a change of product, not a launch.

| Gate | Evidence required |
|---|---|
| Product value | Pilot businesses show that Sevari improves response, qualification or booking outcomes, measured against their own baseline from before the pilot |
| Owner workload | Total owner time spent correcting drafts, handling UNKNOWNs and maintaining business data is measured (time log §54, reply records §10.2), and is lower than the time Sevari saves |
| Reliability | The acceptance corpus and pilot evidence meet the approved grounding, security and escalation criteria (§68) |
| Unit economics | Cost per resolved enquiry and direct cost per customer are measured on the actual infrastructure (§54), with no H values left in the calculation |
| Retention | Pilot customers continue to use the product and show willingness to pay (a signed paid plan or a deposit), not just praise for the concept |
| Operational readiness | Support, incident handling, data recovery, cancellation, export and erasure have been tested (§63 complete) |

The system produces the evidence (pilot report §46, metrics §10.3, cost views §54). The judgement is Dan's.

## 65. Two kinds of billing, and a capability matrix

"Billing" means two different things, and they have different timing:
- **Tenant-side billing (Lifecycle T):** invoices, payment links and overdue chasing that Sevari performs *on behalf of* a business for its customers (§19.2).
- **Veylith subscription billing (Lifecycle V):** how Veylith collects its own revenue from tenants (§19.4).

Every capability is classified in `docs/CAPABILITY_MATRIX.md` as **Pilot** (needed for the first pilots), **Launch** (needed before §64 commercial launch) or **Deferred**. Subscription billing for pilots MAY be manual (invoice and bank transfer or a hosted payment link created by hand). It is not necessary to build a billing platform before demand is validated. §8.1's tenant-side invoicing items are Launch unless the matrix says otherwise. Voice stays out of v1 (§12).

The first customer segment and the five supported trades (§15.7, §42) are decided **before** the evaluation corpus is finalised. The corpus can be drafted earlier, but it is not frozen as the golden set (§32) until Dan confirms them.

## 66. External delivery: exactly-once is not assumed

The outbox and unique constraint (§5.2) prevent duplicate *queue records*. They do not guarantee exactly-once delivery by an external email or SMS provider: a provider can accept a message and Sevari can crash before recording that.

Requirements:
- Every outbound send records an intent **before** the provider call and the outcome **after** it. A send whose outcome is unknown (crash or timeout after the call started) enters an `ambiguous` state. It is never blindly retried.
- Where the provider supports idempotency keys, the send uses one derived from `(draft_id, channel_send)`. Where it supports lookup by our reference, an ambiguous send is **reconciled** (does the provider have it?) before any retry.
- Where neither exists, the residual risk is documented per provider in its ADR, and the system applies duplicate detection (same recipient, same content digest within a window) and recovery (owner task) instead of a silent retry.
- Consequential classes (`payment_request`, `cancel`, `booking_change`, `refund`, `invoice_send`) never retry an ambiguous send automatically. They raise an owner task.
- Tests (red first, Phase 6): **F46** crash immediately before provider acceptance (exactly one send after recovery); **F47** crash immediately after provider acceptance, before the result is saved (no second send; reconciled or escalated); **F48** timeout with an ambiguous outcome (reconcile, then escalate; never a blind retry); **F49** duplicate provider webhooks and provider-side retries (one effect); **F50** consequential classes never auto-retry an ambiguous send.

## 67. Key management: honest threat model

Per-tenant keys (§6.3) limit blast radius between tenants and make crypto-shredding possible. They do **not** protect data against an attacker who compromises the host where both the encrypted data and the key-unwrapping capability are available.

Requirements:
- `docs/security/key-management.md` states the threat model: what each key protects against, what it doesn't, and the residual risk of the v1 single-VPS key file. The README and trust page MUST NOT describe a local key file as independent key security.
- The key-management trust boundary is separate from ordinary application access: the KEK is readable only by a dedicated process or user (not the API process user), unwrap requests are authenticated and logged, and the plan for moving the KEK to a separate host, HSM or managed KMS is written down with its trigger.
- Rotation (KEK and DEK), revocation and recovery are defined and tested: **T-KEY-1** KEK rotation re-wraps every DEK without data loss; **T-KEY-2** a revoked KEK can no longer unwrap; **T-KEY-3** restoring a backup restores encrypted data and wrapped keys without granting any tenant access to another tenant's keys, and without restoring keys that were crypto-shredded after the backup (shred register re-applied, linked to F35); **T-KEY-4** compromise drill: the documented response (rotate, re-wrap, revoke, notify assessment) runs end to end.
- Backups are encrypted with a key that is not stored on the same host as the backup.

## 68. Grounding that can't be gamed

- Replace "never wrong on facts" (§1) as an engineering rule with: **no observed unsupported claims in the acceptance and release evaluation sets; every detected failure blocks the send or escalates; any observed failure in production triggers an investigation and suspends the affected autonomous action class (§7.2 kill switch) until resolved.** Marketing copy may use only claims that meet this (§43 claims register).
- An **adversarial holdout corpus** (`eval/holdout/`) is kept separate from anything used to build or tune the implementation. It covers contradictory facts, expired prices, discounts, exclusions, negation, misleading combinations of individually valid facts, prompt injection, and ambiguous booking requests. It is run at release, its contents are not used for tuning, and it is refreshed by humans.
- The model never certifies its own factual correctness. Grounding is deterministic validation; material claims (prices, dates, times, availability, commitments, remedies) are compared claim by claim against the authorised source record.
- Tests are reviewed by a human as well as code: grounding and approval test changes need Dan's review in the PR.
- Test: **F3H** the holdout corpus passes with zero unsupported claims sent; the holdout files are excluded from any tuning path (a test checks no other code reads them).

## 69. Processor registry separate from the egress allowlist

An allowed hostname is not a processor record.
- `config/processors.yaml` is the structured processor registry: purpose, data categories, hosting region and data locations, sub-processors (with a source link), terms and DPA reference, retention, transfer mechanism, review status and review date, and the human approval record.
- Each egress allowlist entry references a processor id. CI fails if an allowlisted host has no approved processor entry, or a processor has hosts that aren't allowlisted.
- `docs/PROCESSOR_REGISTER.md`, the tenant-facing sub-processor list and the ROPA inputs are generated from the registry plus the allowlist. A new processor still needs human approval (§29).
- The actual data destination of email and SMS services is tested where the provider allows it (for example, the region a message is stored in). A UK-hosted database does not by itself establish that all processing stays in the UK.

## 70. Service levels, recovery and performance

- Before live use, Dan approves in `config/slo.yaml`: availability target, RTO, RPO, backup frequency and restore acceptance criteria. Until approved, the values are null and the cell refuses live tenants (boot check, like §8.4).
- The acknowledgement target is stated with its percentile and conditions: **ACK p95 ≤ the F7 target, measured under 20 concurrent enquiries with the model busy, and separately with the downstream messaging provider slow** (provider latency injected). The ACK is persisted and queued within the target even when the provider is slow; delivery time is reported separately.
- Load tests at increasing concurrency report queue delay, error rate and the capacity limit of the target box (§36.1 capacity engine).
- No document promises more availability or recoverability than the infrastructure provides. The trust page shows measured values only.

## 71. Legal controls stay precise

- **Sign-offs are auditable approval records.** Counsel and Dan sign-offs (§8.4 region packs, §17 tiers, money mode, learning register) are `human_inputs` approvals with the approver's identity, role, date, scope and expiry, written to the audit chain. A configuration field may mirror the approval, but the boot check verifies the approval record, not the field alone.
- **Breach handling is assess-then-notify.** A detected incident starts an immediate assessment workflow with a running clock. Whether the regulator and data subjects must be told depends on the applicable threshold (for the UK: whether the breach is likely to result in a risk to people's rights and freedoms, and for data subjects, a high risk). Where reporting is required, it is made within 72 hours of becoming aware where feasible, with reasons for any delay. The system drafts; a human decides and releases (§36.4). This replaces any reading of §8.4 that every incident is reported within 72 hours.
- **Article 22 classification per use case.** §8.3's reservation of decisions with legal or similarly significant effects stays in force as a precaution. Whether a given automated decision is in fact solely automated with such effects is confirmed per use case by counsel and recorded in the decision register. The reservation is never loosened by that classification without a constitutional amendment.

## 72. Phase table additions

| Phase | Scope | Exit |
|---|---|---|
| 6 (added) | Delivery ambiguity handling | F46–F50 green |
| 4 (added) | Adversarial holdout corpus | F3H green |
| 7 (added) | Key-management boundary, rotation, revocation, restore | T-KEY-1..4 green; `docs/security/key-management.md` |
| 2 (changed) | Processor registry linked to the allowlist | Register generated from `config/processors.yaml` |
| PR | Production Readiness (§63) | Every PR item evidenced and signed |
| VG | Value Gate (§64) | Dan's approval on evidence |

## 73. Changelog

- **v1.11 (14 October 2026, drafted at Dan's request):** Part K added: §74 every human input acknowledged and acted on, customer holding update, silence never approves (F51–F54); Agent Mode (§75–§80) with the seven agents as signed packs, models without tools, new action classes, briefs, plans as data, phases K1–K6 and tests A1–A12. Name: Sevari. Constitutional note: §8.3 tightened only (`code_deploy`, `infra_change` always human).
- **v1.10 (13 October 2026, Dan):** Part J added: build-complete vs production-approved vs commercially launched; Production Readiness phase; Value Gate; billing split and capability matrix; delivery-ambiguity tests F46–F50; key-management threat model and T-KEY tests; adversarial holdout corpus F3H and the testable replacement for "never wrong on facts"; structured processor registry; SLO/RTO/RPO approval; auditable sign-offs, assess-then-notify breach handling, Article 22 classification per use case. §3 and §8.3 are clarified and tightened, never loosened (constitutional note: §71 keeps the §8.3 Art. 22 reservation intact).

---
---

# PART K — Agent Mode, and acknowledging every human input (added in v1.11)

Status: **drafted by Claude Code at Dan's request on 14 October 2026; binding when Dan merges it.** Part K overrides Parts A–J wherever they conflict, except §3 and §8.3, which it only tightens. Decisions recorded with it: the product name is **Sevari**; silence never approves; AI-drafted content is disclosed where the tenant's policy or the law requires (§8.4).

## 74. Every human input is acknowledged and acted on

This extends §30 (INV-12 to INV-16) with a rule Dan set: no human input goes unanswered, and silence never approves.

1. **Acknowledge on receipt.** Every human input (approve, reject, edit, answer, instruction, sign-off) gets an immediate acknowledgement on the channel it came from, saying what was understood and what will happen next. For example: "Approved. Sending your reply to the customer now." An input that can't be accepted (stale, wrong role, ambiguous) gets an acknowledgement that says so and what happens instead (§30.4).
2. **Confirm the effect.** When the effect receipt is written (INV-13), the human is told the outcome: "Sent at 10:02 and delivered." A failed effect is reported the same way, with the next step.
3. **Nothing is left pending without a clock.** Every open question to a human shows in the owner inbox with its deadline and its declared safe default (§30.3). An unanswered question escalates (§30.6 batching applies); it never resolves itself to "approve".
4. **The customer is never left in silence.** While an approval is pending, the customer has the deterministic acknowledgement (§5.2). If the approval is still pending at the reply time the tenant has stated, the customer gets one deterministic holding update (an `ack`-class template, no model wording, no commitments). The holding update is a tenant setting, on by default, and is not an approval of anything.
5. Tests: **F51** every human input produces an acknowledgement on its channel within the ACK target; **F52** every applied input produces an outcome confirmation; a failed effect produces a failure notice; **F53** a pending approval past the stated reply time produces exactly one holding update to the customer and no other send; **F54** no code path turns silence or timeout into approval (extends F24).

## 75. Agent Mode: scope

Sevari has two modes on one engine:
- **Enquiry Mode** (Parts A–J): inbound enquiries from a tenant's customers.
- **Agent Mode** (this Part): **tasks** from the tenant (or scheduled) that specialist agents carry out for the tenant's business.

Both modes share intake, threat screening, tenancy, encryption, the autonomy engine, human input, grounding, audit and metrics. Nothing in Agent Mode bypasses any of them. A task is an inbound item of kind `task` with an optional `target_agent`; without one, the router chooses deterministically, falling back to BASTION, and the choice is recorded with its confidence.

## 76. How agents work (reconciling "tool access" with §5.3 and §36.3)

- **The model never holds tools.** An agent's model proposes a structured action (a JSON schema per action type). The deterministic workflow validates it, runs the autonomy policy (§7), and only then calls a **tool adapter**. Tool adapters are channel or integration adapters (§9, §36.1): they declare their egress hosts, data scope and ADR, and live behind the egress allowlist (INV-3).
- **Each agent is a signed, versioned pack** (§36.1): role, prompts, allowed action classes, tool adapters, schedules, model routing by task type (§9), templates for its fallback, and an eval suite. An agent can only use the action classes in its pack: no agent can do another agent's job.
- **Every agent has a template floor.** If the model fails, the agent produces its template output or escalates to a human (T5/T6 in the original design). It never improvises.
- **Agent output is grounded.** Factual claims come from tenant records, the claims register (§43) or cited sources (COMPASS). Ungrounded output is blocked, not edited (§68).

## 77. The seven agents

| Agent | Role | Action classes (new ones marked *) | Gate | Constraints |
|---|---|---|---|---|
| **BASTION** | Customer support: the Enquiry Mode engine | existing (§7.2) | as §7.2 | Unchanged |
| **SENTINEL** | Health of the tenant's Sevari setup and of the cell | `report_internal`* | automatic to the dashboard | Read-only telemetry. Infrastructure changes are `infra_change`* and Dan-only (§8.3) |
| **LEDGER** | Finance: invoices, chasing, reconciliation, summaries | `invoice_send`, `payment_request`, `refund`, `report_internal`* | always approval for money movement (§19) | Mode 1 only (D1). The model never computes money; it may word a summary of computed figures |
| **VANGUARD** | Lead follow-up and pipeline | `outreach_send`*, `marketing` | always approval until a grant; Tier C first touch never grantable | Tiers A and B only (D3). Suppression, provenance, quiet hours, frequency caps (§17.2) |
| **HERALD** | Content: posts, newsletters, case studies, web copy | `content_draft`*, `content_publish`* | `content_publish` always approval | Sources are the tenant's own records and the claims register. No web crawling. Newsletters to people are marketing (PECR consent, §17). Case studies need the subject's written consent |
| **COMPASS** | Market intelligence | `report_internal`*, `recommendation`* | reports automatic to the dashboard; recommendations are suggestions only | Sources only from a **source register** (terms of use checked, `counsel_signoff` where needed, like §17.1 Tier E). No collection of personal data about individuals. Every finding cites its source and date |
| **FORGE** | Website and code work for the tenant | `code_change`*, `code_deploy`* | `code_change` = a branch and a pull request, approval to merge; `code_deploy` always approval, never grantable | Only on repositories the tenant connects. Never on Sevari itself. Sandboxed runs, no secrets in prompts, tests must pass. Highest risk: built last, with its own security review |

New action classes (`report_internal`, `recommendation`, `content_draft`, `content_publish`, `outreach_send`, `code_change`, `code_deploy`, `infra_change`) extend §7.2. `code_deploy` and `infra_change` join the reserved list as always-human (§8.3, tightened; constitutional note: tightening only).

## 78. Owner briefs and plans

- **Morning brief (07:00) and evening summary (19:00)**, tenant-local time and configurable: overnight and daily activity, items awaiting the owner (each with its approve/reject link and deadline), outcomes of earlier inputs (§74), health, key metrics and learning proposals. Every line links to the audit events behind it. Briefs are owner-facing service messages, not marketing.
- **Plans and entitlements as data** (§47): which agents and limits a plan includes. Features above a tenant's plan are visible, described and labelled with the plan that unlocks them, and inaccessible. No dark patterns.
- Over a plan's allowance, Enquiry Mode never stops acknowledging customers (§5.2). What else continues is plan data, decided by Dan.

## 79. Agent Mode phases (each starts with its tests red)

Agent Mode starts after Phase 18 and Phase 6 (human input and approvals) are green, because every agent depends on them.

| Phase | Scope | Exit |
|---|---|---|
| K1 | Task intake and router, agent pack framework, structured action proposals, template floor, briefs, SENTINEL | A1–A6 green |
| K2 | LEDGER as an agent over Part B finance (Phases 12–13) | A7 green, F14–F18 still green |
| K3 | VANGUARD over Part B sourcing (Phase 10) | A8 green, F9–F13 still green |
| K4 | HERALD with publishing adapters (each with an ADR) | A9 green |
| K5 | COMPASS with the source register (counsel sign-off per source type) | A10 green |
| K6 | FORGE with a sandbox and a repository adapter (ADR, security review) | A11–A12 green |

Tests:
- **A1** a model output can never call a tool adapter directly; only a validated, policy-approved action can.
- **A2** an agent can't use an action class outside its pack.
- **A3** a task goes through threat screening, grounding and autonomy exactly like an enquiry; there is no task bypass.
- **A4** when the model fails, the agent uses its template floor or escalates.
- **A5** every brief line links to existing audit events; a brief never includes another tenant's data.
- **A6** the router's choice is deterministic for the same input and is recorded with its confidence.
- **A7** LEDGER can't move money or send a payment request without approval.
- **A8** VANGUARD can't contact anyone outside Tiers A/B or suppression rules.
- **A9** HERALD can't publish without approval, or publish a claim missing from the claims register.
- **A10** COMPASS can't read from a source that isn't on the source register, and its reports carry no personal data about individuals.
- **A11** FORGE can't push to a default branch or deploy without approval.
- **A12** secrets never appear in a FORGE prompt or log.

## 80. Open decisions added by Part K (owner: Dan)

1. HERALD's publishing channels (for example LinkedIn, X, a website CMS): each needs a provider ADR.
2. COMPASS's first source types (for example Companies House, public tenders, industry news feeds).
3. ~~FORGE: in scope for the first commercial release, or later?~~ **Decided 14 Oct 2026: deferred (§84).**
4. Which plan includes which agents (prices are data, §47; three price lists exist, Q-2).

---
---

# PART L — Vision alignment decisions (added in v1.12)

Source: Dan's decisions of 14 October 2026, after comparing the Product Brief, Design Brief v2.2 and Synchronicity v1.0 with this contract (`docs/reference/original-vision.md` §7). Part L overrides earlier parts where they conflict. **Constitutional amendment note (§14):** §81 clarifies §8.3 ("activating a customer" stays always-human; §81 says *which* human for each case). Nothing in §3 or §8.3 is loosened: no activation, approval or exception can ever be made by configuration, timeout or a model.

## 81. Fast, safe go-live (amends §18, T-ONB-1, T-ONB-3)

Target from the Product Brief: a new business answers the onboarding questions in about ten minutes and its first enquiry is handled within an hour of sign-up, with no setup call.

1. The onboarding interview (§18 step 2) produces typed knowledge records that the owner previews and confirms (I5, unchanged).
2. An **automatic go-live checklist** runs: confirmed business record (name, reply-time promise, privacy notice link); at least one service; hours; area; every price either confirmed or explicitly "on inspection"; at least one channel verified with a test message; a synthetic test enquiry set passed with zero grounding failures; the pack is not `regulated: true`.
3. When the checklist passes, the **owner's own "go live" tap** (a typed human decision, §30, acknowledged and acted on, §74) activates **Assist mode**: the deterministic acknowledgement goes out automatically (§5.2), and every other reply waits for an approval.
4. **Shadow mode** (§18 step 5) becomes an option the owner can choose, recommended in the onboarding flow, not a required wait. If chosen, leaving it is still a human decision (T-ONB-3 unchanged for tenants in shadow mode).
5. **Veylith's (Dan's) approval** is still required to activate a tenant whose pack is `regulated: true`, or whose onboarding detected a regulated activity (§83.4), and for anything listed as a platform exception in §82.
6. Measured: sign-up → first acknowledged enquiry, and sign-up → go-live, per tenant (metrics, §10.3).

Tests: **T-ONB-1** (amended) no activation without the checklist plus a human decision by the tenant's owner, or by Veylith where §81.5 applies. **T-ONB-4** a regulated or regulated-detected tenant can't be activated by its owner alone. **T-ONB-5** a failed checklist item blocks the go-live tap and says exactly what's missing.

## 82. Who decides exceptions: two authority scopes (amends §7, §30, §74; answers Q-17)

- **Platform scope (Veylith, Dan as founder and CEO; never delegable):** product and build exceptions. Constitutional amendments, reserved decisions at platform level (§8.3), platform ceilings on what any tenant may automate, regulated verticals and regulated-detected tenants (§81.5), processors and egress (§29, §69), model promotion (§9), learning-gate promotions (§31), outbound tier changes (D3), and cross-tenant or operator access (break-glass, audited). Platform decisions can be made only by an operator credential with Dan's identity.
- **Tenant scope (the business owner; multi-tenant gated and credentialed):** the tenant's own exceptions. Approvals for its own drafts and actions, its own autonomy grants within the platform ceilings (§7.2), its own go-live (§81), and which of its own users may do what.
  - The owner can add **team members** to their tenant, each with their own login (passkey per R-12) and a role: owner, approver (limited to the action classes the owner chooses), or viewer.
  - The owner can set an **escalation order**: if an approval isn't answered within a delay the owner chooses, it is offered to the next authorised team member. Each person must **actively** approve; silence never approves (INV-14), and every hand-over is acknowledged to the owner (§74).
  - Money classes (§19) are owner-only unless the owner explicitly grants a named team member that right.
  - A tenant's users never see or act on another tenant (INV-1). **Veylith never approves anything on a tenant's behalf.** Support access is read-only, time-limited, consented by the owner and audited.

Tests: **F55** a tenant approver can't approve an action class the owner didn't grant them. **F56** a platform decision attempted with a tenant credential (any role) is refused and audited. **F57** an unanswered approval escalates in the owner's order, is never approved by the timeout, and every hand-over produces an acknowledgement. **F58** no Veylith or operator credential can approve a tenant action.

## 83. Any service business, and Sevari finds its own audience (amends Part D, §9; answers Q-16)

1. **Not limited to one audience.** The five trades remain the first pilot packs (Part D), but the product is for any service business or individual. A **generic service pack** handles the core intents (enquiry, price, booking, availability, follow-up, complaint, opt-out, data rights, thanks) for any sector.
2. **Pack builder.** The onboarding interview drafts a tenant-specific pack (services and their everyday names, the questions to ask, slots, templates) from the owner's answers. The owner confirms it (I5). It is evaluated against synthetic test enquiries generated from it before go-live (§81.2). Packs that prove useful across tenants can be promoted to the shared catalogue (§36.1) through the learning gate (§31), with no customer data moving between tenants (§31.4).
3. **Sevari sources its own audience, within the law (D3 unchanged).** Veylith runs as **tenant zero** (R-22): Sevari answers Veylith's own enquiries ("talk to Sevari herself"). HERALD drafts content from Veylith's own material and posts after approval or an earned grant. Opted-in leads (waitlist, newsletter, demo requests) are followed up under Tier B. Everything is automated except the decisions §8.3 and Part K keep human. Cold outreach (Tier C and beyond) stays off until counsel signs off per region, with an ADR and Dan's decision (D3). No scraping or collection of personal data from sources outside the source register (§17.1, §80).
4. **Regulated-activity detection.** Onboarding answers, company records (where an ADR allows, R-20) and service names are checked against a maintained list of regulated activities. A match sets `regulated: true` and routes activation to Veylith (§81.5). Examples: gas, electrical, childcare and childminding (children's data, Ofsted), health, legal, finance. Counsel confirms the list.

Tests: **T-PACK-1** a drafted pack can't go live until the owner confirms it and its synthetic test set passes. **T-PACK-2** a regulated-activity match blocks owner-only activation.

## 84. FORGE deferred (answers Q-18 and §80 item 3)

FORGE keeps its name and its place in the Agent Mode design (Part K). It is **not built or sold** until there is in-cell GPU inference and a defined use for service businesses, under its own contract part. Phase K6 is deferred. Plans and copy must not offer it until then.

## 85. Claims wording (adds to §43)

The ten statements listed in `docs/reference/original-vision.md` §7.3 go into the claims register with their evidence or a "do not publish until counsel confirms" status. Public copy uses the true versions given there.

---

# PART M — Free until revenue, HIVE, the integration layer, self-improving knowledge and growth (added in v1.13)

Source: Dan's decisions of 14 October 2026. Part M overrides earlier parts where they conflict. It doesn't touch §3 or §8.3.

## 86. Free to run until Sevari earns money (cost gate)

1. **Rule.** Sevari must not create running costs before it generates revenue, beyond the unavoidable base (the cell's server, domain and certificates: the fixed cash cost in Part G).
2. **Every paid service sits behind a port with a free default.** Examples: local models instead of paid AI; a self-hosted web fetcher instead of a paid scraping service; the local key file before a paid KMS (§67 keeps the boundary); self-hosted monitoring; free provider tiers where they exist. The paid adapter is built, tested and kept ready, but stays **off**.
3. **Switching on a paid service** needs: a processor entry and ADR (§29, §69); a cost line in the capacity model (Part G); evidence that monthly revenue covers its forecast cost with margin (from billing data, §13 phases); and Dan's recorded decision (platform scope, §82). It is a configuration change with an approval record, never a code change.
4. Fees that only arise when Veylith is paid (card processing) are allowed.
5. Per-tenant costs (texts, numbers) are allowed only for tenants whose subscription covers them (§87).

Tests: **T-COST-1** a paid adapter can't be enabled without a cost line, a revenue check and a platform decision. **T-COST-2** with every paid adapter off, the full Enquiry Mode path works (intake, ACK, drafting, approval, send on free channels).

## 87. Texts only for paying customers (answers SMS costs)

Before a tenant pays, Sevari uses only free channels: email, web forms, the chat widget and owner app notifications. SMS sending, SMS approvals and missed-call text-backs (§49–§51) are enabled per tenant only while that tenant has an active paid plan, and stay within the plan's text allowance (plan data, §47). When a tenant stops paying, texts stop and the free channels carry on (§5.2: customers are still acknowledged on every free channel).

Test: **T-SMS-1** an SMS send, SMS approval or missed-call text for a tenant without an active paid plan is refused before any provider call, and a free-channel fallback is used where one exists.

## 88. HIVE: Sevari's self-learning (names §31–§35)

"HIVE" is the product name for governed self-learning (§31–§35, Phases 20–23). Nothing about its rules changes:
- It learns from approvals, rejections, edits, outcomes and complaints.
- It proposes changes, tests them offline and in shadow, and promotes them only through the human gate. Dan decides platform-level changes; each owner decides changes to their own business (§82).
- It never creates facts, never changes the legal perimeter and never widens its own authority.
- Cross-tenant learning (including a future product starting "pre-trained", vision C-7) uses only aggregated, anonymised statistics and owner-approved, de-identified phrasing (§31.4).

## 89. The integration layer (CIL): connects to everything, depends on nothing

From the vision (Architecture v2.3, §8): *external systems become tools that follow Sevari's rules, not dependencies Sevari relies on.*

1. **One integration port**, with an adapter per platform. Each adapter declares its egress hosts, data scope, auth method, rate limits and ADR (§29, §69). Credentials are encrypted per tenant (§6.3) and never shown to a model.
2. **Scope: all four categories, built in this order**, because each enables the next:
   1. Calendars (Google, Microsoft 365/Outlook, CalDAV) for real availability and bookings.
   2. Trade and field-service job software (for example Jobber, Tradify, ServiceM8, Fergus, Commusoft).
   3. Accounting (Xero, QuickBooks, FreeAgent, Sage) for invoices and payment status (LEDGER).
   4. CRM and helpdesk (HubSpot, Zendesk, Salesforce, Freshdesk, Pipedrive, Microsoft Dynamics).

   More platforms are added as adapters (packs, §36.1), never as core changes.
3. **Free to run (§86).** Each tenant connects its own account with that platform's own sign-in (OAuth or the tenant's API key), so the tenant's subscription with that platform carries any cost. Veylith uses free developer and partner programmes. A connector that needs a paid Veylith account stays off until §86.3 is met.
4. **Sevari is always the master of** its own decisions, approvals, grounding, knowledge records (I5), consent and suppression, and audit trail.
5. **For contacts, jobs and tickets, the owner chooses the master per data type.** In the other direction, a change arriving from the non-master system becomes a **proposal**, never a silent overwrite. Conflicts are shown to the owner as one decision (§30).
6. **External data is untrusted input** (§36.3). It never becomes a fact Sevari tells a customer until the owner confirms it as a knowledge record (I5).
7. **Every action Sevari takes in another platform** (create a ticket, book a calendar slot, raise an invoice) is an action class under approvals and autonomy (§7, INV-4) and goes through the outbox with reconciliation (§66).
8. **Independence.**
   - Disconnecting or losing any integration never stops Enquiry Mode: work queues, the owner is told, and nothing is lost.
   - Export is always available in open formats (§21).
   - No platform's terms may be accepted if they would claim ownership of tenant data or restrict the tenant leaving. The ADR checks this.

Tests:
- **F59** data from an integration never reaches a customer as a fact without owner confirmation.
- **F60** with every integration disconnected, Enquiry Mode runs end to end and the owner is notified.
- **F61** an action in an external platform without a valid approval or grant is refused.
- **F62** a change from the non-master system creates a proposal; nothing is overwritten.
- **F63** integration credentials never appear in prompts, logs or audit payloads.

## 90. Self-improving knowledge

Knowledge stays owner-confirmed (I5). What improves itself is how quickly gaps are found and closed:
1. **Gap detection.** The same UNKNOWN (§5.4) arising repeatedly across enquiries becomes **one** question to the owner (§30, acknowledged per §74). The answer becomes a knowledge record after the owner confirms it.
2. **Freshness.** Each record type has a review age (config; for example prices every 90 days). Sevari asks the owner to reconfirm. Nothing is changed or expired automatically, but an out-of-date price is marked so replies say "we'll confirm" until it is reconfirmed.
3. **Cross-checks.** Where an integration, the owner's own website (fetched by the free fetcher, §91.3) or a public register (R-20) disagrees with a knowledge record, Sevari raises a proposal for the owner. Sources are recorded on the proposal.
4. **Learning feed.** Approved answers, edits and new records feed HIVE (§88) under §31's rules.

Tests:
- **T-KNOW-1** repeated identical unknowns produce one owner question, not many.
- **T-KNOW-2** a stale price is never used as a confirmed fact, and is never changed without the owner.
- **T-KNOW-3** a disagreeing external source creates a proposal and never edits a record.

## 91. Growth: Sevari finds its own customers, free to run

All within D3 (inbound and opt-in only) and §86 (no running cost).

1. **"How fast do you reply?" free check.**
   - The owner verifies a business email address (a code sent to it) or their website (a code they add). Then they tick a consent box and Sevari sends **one** realistic test enquiry to that verified address.
   - Sevari times the reply. It reports the time and what Sevari would have replied, grounded only in facts from the owner's own public website; anything not on it says "we'd ask you".
   - The test message carries a reference shown in the report.
   - Marketing follow-up needs a separate, unticked-by-default consent.
   - The fetched page and the test message are deleted after a short period (config, default 30 days). The timing and report are kept with the lead record.
2. **Referrals that only pay out on payment.**
   - Each paying tenant gets a referral link. The reward ("give a month, get a month", plan data) is granted only after the referred business has made its second successful payment.
   - Rewards are LEDGER entries with the usual approval rules.
   - An optional "Powered by Sevari" link on tenant forms is offered for a discount and measured. It is dropped if it doesn't convert.
3. **The free web fetcher** is its own isolated service with its own allowlist mode:
   - It fetches only verified domains, respects robots.txt and rate limits, and keeps no cookies.
   - It runs with no database credentials for tenant data and has its own ADR.
   - INV-3 still holds: a completed verification creates a time-limited allowlist entry for that one domain in the fetcher's own isolated egress policy. That entry is the only thing that lets it reach the domain, and it expires (default 30 days).
4. A free "never miss an enquiry" plan is **not** offered until revenue data shows it pays for itself (§86).

Tests:
- **T-GROW-1** the check can't be run against an unverified address or domain.
- **T-GROW-2** a referral reward is never granted before the referred tenant's second payment.
- **T-GROW-3** the fetcher can't reach a domain without a verification record and has no access to tenant data.
- **T-GROW-4** no marketing message goes to a check user without the separate consent.

## 92. Phases for Part M

| Phase | Scope | Exit |
|---|---|---|
| M1 | Cost gate (§86), texts-only-for-paying (§87) | T-COST-1, T-COST-2, T-SMS-1 green |
| M2 | Integration port and the four categories in order (§89) | F59–F63 green; each connector's ADR approved by Dan |
| M3 | Self-improving knowledge (§90), after Phases 18 and 20 | T-KNOW-1..3 green |
| M4 | Growth (§91), after Phases 11 and 13 | T-GROW-1..4 green |

---

# APPENDIX 1 — UK go-to-market plan (inbound and opt-in only)

*Included for context. Proposals and hypotheses, not requirements, except where Parts D and E say so.*

### Sevari BDI — UK Go-To-Market Plan (inbound and opt-in only)

Version 1.1 · 12 October 2026 · Owner: Dan Hadfield, Veylith Systems (Ellesmere Port)
Scope: Tiers A (inbound) and B (opt-in) only. No cold email, SMS or calls. No bought lists. No scraped prospect lists.
Pilot market: Ellesmere Port (decided by Dan). Trade shortlist: provisional. Pilot pricing and outreach detail is in PILOT_PRICING_AND_OUTREACH_PLAN.md (Appendix 2 of the build contract).
Status: draft for Dan. Every number marked "target" is a hypothesis to test, not a fact. Nothing here is legal advice. Counsel confirms the compliance points.

---

#### 1. Who we're selling to

**Beachhead:** owner-run service businesses with 1–9 staff, where the owner is on a job and can't reply in time.

Why this segment and not sole traders first:
- Construction is the largest UK small-business sector: 885,000 small and medium businesses at the start of 2025 (DBT Business Population Estimates, via [Sectorial](https://sectorial.io/resources/blog/most-smes-uk)). About 500,000 of those are estimated unregistered sole traders and partnerships, 191,000 are registered with no employees, 174,000 have 1–9 staff.
- Sole traders are the most numerous but likely the least able to pay, and under PECR they count as individuals, so email and text marketing to them needs consent ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/)).
- 1–9 staff firms are a hypothesis: more admin pain, more job value, a stronger case for paying. The pilots test it.

**First five trades (provisional):** drainage, roofing, locksmiths, garage doors, landscaping and driveways. Held in reserve: pest control, appliance repair (not gas). Excluded until a human approves: gas, heating and electrical.

**Positioning:** not "a cheaper answering service". Many AI call-answering vendors already target trades, and they are voice-first (for example [Whoza](https://whoza.ai/research/missed-call-index) and [Callout AI](https://calloutai.co.uk/blog/cost-of-missed-calls/)). Sevari's version one has no voice channel, so the pitch is:
> Every enquiry acknowledged in seconds, every quote and booking accurate, every record kept compliant, and a reply you can trust because it never invents a price.

Plan a voice adapter after the baseline exists. Be honest with prospects that voice isn't in version one.

#### 2. Claims discipline

The market is full of unreliable statistics. Most "£24,000 lost a year" figures come from vendor blogs and recycle a 2016 survey of 300 firms. Use only:
- Claims with a named, dated source you've read.
- Your own pilot measurements (response time, enquiries handled, owner minutes saved).
- Cautious, attributed statements, such as [34% of 220 surveyed tradespeople believed they lost work by missing calls](https://voxbot.io/blog/best-phone-system-tradespeople) (a small survey, quoted via a vendor blog: label it that way), or the [January 2026 Moneypenny survey finding that 23% of customers would call again after a missed call](https://powerednow.com/missed-calls-cost-you-money/).

Keep a claims register (source, date, status: verified, vendor-reported, own measurement). Anything unverified doesn't go into marketing.

#### 3. Compliance guardrails for every channel

From the ICO's guidance on business-to-business marketing:
- Limited companies, LLPs and some public bodies are corporate subscribers. Sole traders and ordinary partnerships are treated like individuals, and you can only email or text them with specific consent, or under the soft opt-in for your own prospects and customers ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/)).
- You can't tell from an email address whether someone is a sole trader or a company, so treat "unknown" as an individual.
- Consent must be freely given, specific and informed, with an unticked box, separate consent per channel, a record of who, when and how, and an easy way to withdraw ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/)).
- Soft opt-in covers messages about your own similar products to people whose details you got while they were buying or negotiating, with an opt-out given at collection and in every message ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/)). It doesn't cover new contacts.
- Practical rule for networking: a business card or a conversation isn't consent to marketing email or text. Collect opt-in through a form or QR code at the time.
- Even where PECR doesn't require consent, you must say who you are and give an opt-out, and UK GDPR still applies to the personal data of business contacts.
- Keep a suppression list and honour opt-outs immediately.
- Counsel to confirm: the current PECR position (the law has been changing, so verify), your ICO registration and fee position, the lawful basis for each channel, and the wording of the consent text.

#### 4. Channels (all inbound or opt-in)

| # | Channel | What it is | Why it's inbound or opt-in | First step |
|---|---|---|---|---|
| 1 | Local networking, Ellesmere Port and Chester | In-person conversations, then a QR or short opt-in form | Contact only after the person opts in | Visit 3 groups for free (§5) |
| 2 | Referral partners | Web designers, bookkeepers, trade suppliers, insurance brokers, local accountants who serve trades | The partner introduces; the business chooses to engage | Recruit 5 partners (§6) |
| 3 | Free missed-enquiry calculator | A web tool that shows the cost of slow replies using the visitor's own numbers | Visitor-initiated; contact captured only by opt-in | Build with the contract's §43 rules |
| 4 | Search and content | Plain guides for trades on replying fast, quoting, GDPR for small firms, dealing with complaints | Visitor-initiated | 12 articles in the first quarter, one per week, each with a sourced claim |
| 5 | Google Business Profile, directory listings | A listing for Veylith and Sevari | Visitor-initiated | Set up the profile and 2–3 directories |
| 6 | Organic social posting | LinkedIn and Facebook groups for trades, posts and replies only. No unsolicited direct messages | Public content that people choose to follow. Group rules apply | 2 posts a week |
| 7 | Pilot case studies and word of mouth | Results from pilots, published with the owner's written consent | Customer-initiated | After the first pilot report |
| 8 | Trade body and chamber member offers | A listing or talk through a local chamber or FSB branch | The member requests it | Introduce to the chamber and FSB (§5) |
| 9 | Waitlist and demo request page | The conversion point for everything above | Opt-in | Live before any promotion |

Not used: cold email or SMS, cold calls, purchased or scraped lists, unsolicited LinkedIn messages, lead-discovery tools. These are Tiers C–F and are disabled (contract D3).

#### 5. Local plan: Ellesmere Port and the surrounding area

Verified listings (check dates and prices before attending):
- **KCC Chester & Ellesmere Port:** third Friday of the month, 10:00–12:30, Hospice of the Good Shepherd, Backford; first visit free ([KCC](https://www.kccnetworking.co.uk/chester-ellesmere-port)).
- **networx Cheshire Oaks:** fortnightly Tuesday lunchtime at Old Hall Farm, Kinsey Road, Ellesmere Port; first visit free, then £13.70 per visit ([EventsList](https://eventslist.co.uk/chester/events/networx-cheshire-oaks-2026-10-13)). Membership is advertised at £660 for 12 months per venue ([networx4business](https://networx4business.co.uk/)).
- **BNI Chester:** Thursday mornings, 6:45am, Grosvenor Pulford; visitors pay £20 ([EventsList](https://eventslist.co.uk/chester/events/bni-chester-business-networking-meeting-2026-09-03)). BNI is also [creating a new Ellesmere Port chapter](https://bnicheshire.co.uk/en-GB/EllesmerePortHome), meeting Wednesday at 7am. BNI allows one business per category per chapter, so check the chapter's rules before committing.
- **Let's Talk Business Cheshire West:** the council's business support programme, with events at Whitby Park, Ellesmere Port ([LTB CW](https://www.letstalkbizcw.co.uk/business-directory/)). Ask about support for local businesses and any current programmes. I haven't verified eligibility.
- **West Cheshire and North Wales Chamber of Commerce** and the **FSB** branch for Merseyside, West Cheshire and Wigan ([Syob](https://www.syob.net/uk/business-networking/Liverpool/209)). Ask about member events, talk slots and member offers.
- **Wirral & Chester Business Fair:** held on 24 September this year ([events listing](https://www.business-events.org.uk/en/static/events.xml)). Find the date for next year and decide whether to exhibit.

Pilot market: **Ellesmere Port** (decided). Local pilot goal: 3–5 owner-run trade businesses based in or serving Ellesmere Port, who agree in writing to be a pilot. Chester and the Wirral are the overflow catchment only if Ellesmere Port doesn't produce enough.

Who to meet there: the trades themselves are rarely at breakfast networking. The people who serve them are: accountants, bookkeepers, insurance brokers, web designers, builders' merchants, van and tool suppliers. Treat those as referral partners first, and the trades second.

#### 6. Referral partners

Target: 5 active partners in the first 90 days.
- Offer: a plain, honest partner page; a referral code; transparent referral terms (any fee is written down and the referred business is told about it); and no sharing of the referred business's data with the partner without that business's consent.
- Ask each partner for 3 introductions to their own clients, made by the partner. Never ask for a client list.
- Track: referrals made, demos requested, pilots started, and whether the partner would recommend Sevari again.

#### 7. The offer: pilots first

- Pilot (see the pilot plan for price, terms and outreach): 8 weeks, assist mode only, free or heavily discounted (price to be decided by Dan), a written pilot agreement and DPA, and an agreed exit.
- What the owner gets: a daily digest of enquiries, drafts to approve, and a weekly report of response times, enquiries handled and owner time.
- What Veylith gets: baseline data (contract §10), a case study with written consent, and referrals.
- Conversion: after the pilot, a paid plan, or the data export and erasure as set out in the contract.
- Pilots can't start until the build reac