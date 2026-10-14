# Sevari BDI — sevari-core

The operations layer for service businesses: it takes in every enquiry, works out what's true, replies, books, bills and keeps the records. It automates everything that can lawfully be automated, and hands everything else to a human with the facts already gathered.

Built to the binding build contract in [`docs/BUILD_CONTRACT.md`](docs/BUILD_CONTRACT.md) (v1.9). If the code and the contract disagree, the code is wrong or the contract needs amending.

---

## For Dan: where things stand (plain English)

**Last updated:** 13 October 2026 · **Branch:** `claude/sevari-core-build` · **Contract:** v1.11

**Status: build in progress.** Under contract Part J there are three separate milestones: *build-complete* (code and tests done), *production-approved* (deployment, recovery, security, support, legal documents all proven: [`docs/readiness/`](docs/readiness/README.md)), and *commercially launched* (pilots prove the product is worth paying for: the Value Gate). Passing automated tests is **not** evidence that Sevari is ready for paying customers.

| Phase | What it is | Status |
|---|---|---|
| 0 | Project skeleton, automatic checks, every contract test written | ✅ Done |
| 1 | The secure database: businesses can never see each other's data, data stays in its region, the tamper-proof record, encryption | ✅ Done |
| 2 | Receiving enquiries (web form, email, SMS, API), the outbound-connection guard and firewall, the supplier register | ✅ Done |
| 3 | The rules engine: what the customer wants, prices, areas, availability, bookings | ✅ Done |
| 4 | The instant acknowledgement, and the fact-checker that stops made-up prices or dates | ✅ Done |
| 5 | The local AI models and how they're scored | Next |
| 18 → 6 | Your approvals: questions to you, one-tap approve, nothing sends without it | Planned |
| 7 | Privacy: erasure, data requests, retention, the consent record | Planned |
| 8 | Measurements and weekly reports | Planned |
| 9+ | Lifecycle, missed-call texts, finance, complaints, offboarding, learning, hardening | Planned |
| K1–K6 | **Agent Mode**: the seven agents (BASTION, SENTINEL, LEDGER, VANGUARD, HERALD, COMPASS, FORGE) as plug-in packs | Planned (after approvals are built) |

**What's proven so far (each one is an automatic test that runs on every change):**
- One business can never read, change or delete another business's data, even if the code has a bug. The database itself enforces it.
- Data can't be written to another region unless a human-recorded transfer agreement allows it.
- The tamper-proof record really is tamper-proof. The tests attack it with full database admin rights; even rewriting the whole history is caught by a signature kept outside the database.
- Personal details are encrypted with each business's own key. Destroying that key makes the data unreadable for good.
- The app refuses to start if any safety check fails.
- Enquiries arrive from website forms, email, SMS and the API. Each one is checked for a valid signature, stored encrypted, and queued in a single step. Sending the same message twice never creates a duplicate.
- The rules engine reads each enquiry and works out the job, the postcode area, how urgent it is, whether you cover it, and what your price and availability records say. It never invents a price: if your records don't say, it marks the question as unknown for you. On 100 test enquiries across your five trades, it routes 94% correctly. It caught **every** danger-to-life case and **every** complaint, legal threat or data request. When it's unsure, it asks the customer a question rather than guessing, and after two tries it hands over to you.
- Your business facts (prices, hours, areas, services) only count once you've confirmed them. Every change keeps its history, so any past reply can be checked against exactly what was true at the time.
- Every customer gets an instant acknowledgement, in your business's name, with your reply-time promise and privacy link. The speed test: 20 enquiries at once, with the server's processor flat out, all acknowledged in under half a second; even with a slow text/email provider, under 5 seconds (target: 10 seconds). Someone who texts STOP is never messaged again. Anyone describing a danger to life gets the safety message (call 999, the gas emergency number). Complaints and legal threats get a polite holding reply and go straight to you.
- Nothing can reach a customer unless it passes the fact-checker. Every price, date, time, phone number, link, postcode, number, promise ("guaranteed", "same day", "free", "refund"...) and "we do / we don't do" statement must match your confirmed records or the customer's own words. Otherwise the message is blocked, never quietly edited. It was tested against thousands of generated fake values and every one was caught.
- Sending is crash-safe. If the system stops halfway through sending, it checks with the provider before trying again, so customers don't get duplicates. Payment and booking messages are never retried automatically; they come to you.
- Sevari can't connect to any outside service unless you've approved that supplier. This is enforced three ways: in the code, by a gatekeeper process, and by the server's firewall (proven by a test). The supplier list (processor register) is generated automatically and currently says: no suppliers approved yet.

**Things I found that you should know:**
- Your old n8n build (v3.6 / v4.1) has 16 bugs I've written up in [`docs/reference/v4.1-behaviours.md`](docs/reference/v4.1-behaviours.md). The serious ones: the "tamper-proof" record could be changed without detection; an approval for one message could be used to send a different one; the approval page could run attacker-supplied code; the encryption step stored data unencrypted if its key was missing; and the erasure step failed with an error. The new build is designed so each of these can't happen, and has a test for each.
- My suggested improvements to the contract are in [`docs/CONTRACT_REVIEW.md`](docs/CONTRACT_REVIEW.md). You decide; nothing changes without you.
- Questions only you can answer are in [`docs/QUESTIONS_FOR_DAN.md`](docs/QUESTIONS_FOR_DAN.md). None of them block the next phases.

---

## Technical overview

### Principles (contract §1, §3)
- **Deterministic core, model for wording.** Code decides *what* is said; a local model only decides *how*. Every outbound fact is grounded or the draft is blocked.
- **Sovereign cells.** Each region is its own cell (database, workers, inference, keys, egress allowlist). Region #2 is config and data, not code.
- **Floors are tests.** Each invariant (INV-1 … INV-19) is enforced by a test that blocks CI.
- **Human decisions are typed records** that must have a consumer and an effect receipt (§30). Silence never approves.

### Layout
```
apps/                 api, worker, owner-ui (from Phase 2)
packages/
  domain/             pure deterministic core: ids, action classes, canonical JSON, normalisers (no I/O; lint-enforced)
  clock/              the only source of time (lint-enforced)
  db/                 migrations, RLS machinery, tenant sessions, schema introspection
  crypto/             KMS port, envelope encryption, blind indexes, rotation, crypto-shred
  audit/              append, verify, signed checkpoints
  region/             region rule packs, live-tenant gate, cell routing
  egress/             allowlist (default deny); the only package allowed to make network calls
  privacy/            erasure registry (INV-6)
  boot/               boot guard (INV-9)
  channels/           channel adapters: web form, signed webhook (email, API), SMS (fake provider until the Twilio ADR)
  intake/             receive → authenticate → persist encrypted → queue, in one transaction; endpoints and API keys
  knowledge/          owner-confirmed, versioned knowledge records; point-in-time snapshots (replay)
  verticals/          the five trade packs (data, not code)
  grounding/          the fact-checker: claims extraction, normalisation, service/commitment checks; GroundedDraft
  templates/          fixed message wording (ACK, safety, holding, clarify), GSM-7 / segment caps
  outbound/           outbox (reserved → sending → sent / ambiguous / failed / blocked), reconcile, suppression, reply records
apps/worker/          queue runner (NOTIFY wake-up, bounded concurrency); inbound.process; ack.send
eval/                 100-case labelled corpus, knowledge fixtures, runner, reports, accepted baseline
apps/api/             Fastify server: /v1/inbound/:channel/:publicId, health, CORS for forms, rate limits
ops/nftables/         default-deny outbound firewall + a namespace test that proves it
config/
  regions/uk.yaml     UK rule pack (counsel_signoff: null until counsel signs)
  egress.allowlist.yaml   default deny; each host names an approved processor
  processors.yaml         structured processor registry (§69); generates docs/PROCESSOR_REGISTER.md
tests/
  contract/registry.ts  every contract test id, its phase and section
  contract/phases.json  phases claimed delivered (the CI gate enforces their tests)
  phase0/ phase1/ ...   the tests
tools/eslint-plugin-sevari  the contract §4 lint rules
docs/                 contract, review, deviations, ADRs, reference behaviours
```

### Database security model (Phase 1)
- Two roles: `sevari_owner` runs migrations; `sevari_app` is what the services use (`NOBYPASSRLS`, owns nothing, least privilege per table).
- Every table has RLS **enabled and forced**. Tenant tables use one policy: `tenant_id = app.tenant_id AND region = app.region`, with writes to other regions only under an active `region_transfer_contracts` row (INV-2) that only the owner role can create.
- Context is set with `set_config(..., true)` inside `withTenant()`, so it's transaction-local and safe with connection pools and PgBouncer transaction pooling.
- Every tenant table has `UNIQUE (tenant_id, id)`, and children use composite foreign keys, so cross-tenant references are impossible.
- The owner role has no policy on tenant tables, so even the migration role reads zero tenant rows.
- **Audit chain:** a database trigger assigns `seq`, `prev_hash` and `hash = SHA-256(prev_hash ‖ canonical row)`, serialised per tenant chain; UPDATE/DELETE/TRUNCATE are refused for every role. `sevari_meta.audit_verify()` recomputes the chain, and Ed25519-signed checkpoints (key outside the database) catch a full rewrite. Audit payloads may not contain personal data.
- **Encryption:** per-tenant data and blind-index keys, wrapped by the cell KEK (local key file in v1, behind a `Kms` port). AES-256-GCM with associated data binding each ciphertext to tenant, region, table, column and row. Rotation keeps old versions readable; crypto-shred is irreversible (a trigger refuses to un-shred).

### Running it
Requirements: Node 22, pnpm 10, PostgreSQL 16 (or Docker for Testcontainers).

```bash
pnpm install
pnpm typecheck && pnpm lint

# Tests need a Postgres superuser URL, or Docker:
export SEVARI_TEST_DATABASE_URL=$(pnpm -s db:local)   # starts a local Postgres 16 on :54329
pnpm test:gate        # what CI enforces: every test of every delivered phase must pass
pnpm test:all         # everything, including red tests for phases not built yet
pnpm contract:status  # table of contract tests: implemented? phase delivered?
pnpm eval             # corpus evaluation → eval/reports/<date>.md (--check fails on a >2 point drop)
```

### CI (`.github/workflows/ci.yml`)
- `secrets`: gitleaks on the full history (INV-10).
- `gate`: typecheck, lint (with the contract rules), fallback secret scan, and the gate suite against Postgres 16.
- `contract-progress`: every contract test, red included, plus the status table. Informational.

### Contract test status
Run `pnpm contract:status` for the live table. After Phase 4: F1 (database and API), F3 (grounding, property-based), F3H (holdout harness; starter cases only, DEV-009), F7 (ACK latency), F2 (static, client, proxy, firewall), F4, T-AUD, T-BOOT, T-MIG, T-IDEM, T-PROC, T-LINT and T-SEC are green; every other F/T test exists and is red until its phase is built.

### Documents
- [`docs/BUILD_CONTRACT.md`](docs/BUILD_CONTRACT.md): the binding contract (v1.9)
- [`docs/CONTRACT_REVIEW.md`](docs/CONTRACT_REVIEW.md): proposed amendments
- [`docs/readiness/README.md`](docs/readiness/README.md): Production Readiness and Value Gate tracker
- [`docs/CAPABILITY_MATRIX.md`](docs/CAPABILITY_MATRIX.md): what's needed for pilots, for launch, or deferred
- [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md): every difference from the contract, with reasons
- [`docs/QUESTIONS_FOR_DAN.md`](docs/QUESTIONS_FOR_DAN.md): open decisions
- [`docs/reference/original-vision.md`](docs/reference/original-vision.md): your original Synchronicity / Operion vision mapped to the contract
- [`docs/reference/v4.1-behaviours.md`](docs/reference/v4.1-behaviours.md): behaviours and defects from the n8n builds
- [`docs/adr/`](docs/adr/): architecture decisions (dependencies, Temporal-ready workflow port)
