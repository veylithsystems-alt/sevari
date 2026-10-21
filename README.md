# Sevari BDI — sevari-core

The operations layer for service businesses: it takes in every enquiry, works out what's true, replies, books, bills and keeps the records. It automates everything that can lawfully be automated, and hands everything else to a human with the facts already gathered.

Built to the binding build contract in [`docs/BUILD_CONTRACT.md`](docs/BUILD_CONTRACT.md) (v1.13). If the code and the contract disagree, the code is wrong or the contract needs amending.

---

## For Dan: where things stand (plain English)

**Last updated:** 21 October 2026 · **Branch:** `claude/sevari-core-build` · **Contract:** v1.13

**Status: build in progress.** Under contract Part J there are three separate milestones: *build-complete* (code and tests done), *production-approved* (deployment, recovery, security, support, legal documents all proven: [`docs/readiness/`](docs/readiness/README.md)), and *commercially launched* (pilots prove the product is worth paying for: the Value Gate). Passing automated tests is **not** evidence that Sevari is ready for paying customers.

| Phase | What it is | Status |
|---|---|---|
| 0 | Project skeleton, automatic checks, every contract test written | ✅ Done |
| 1 | The secure database: businesses can never see each other's data, data stays in its region, the tamper-proof record, encryption | ✅ Done |
| 2 | Receiving enquiries (web form, email, SMS, API), the outbound-connection guard and firewall, the supplier register | ✅ Done |
| 3 | The rules engine: what the customer wants, prices, areas, availability, bookings | ✅ Done |
| 4 | The instant acknowledgement, and the fact-checker that stops made-up prices or dates | ✅ Done |
| 5 | The local AI models and how they're scored | ✅ Code done · **your step:** run the model benchmark on the VPS ([how](docs/ops/model-benchmark.md)) |
| 18 → 6 | Your approvals: questions to you, one-tap approve, nothing sends without it, your inbox app | ✅ Done |
| 7 | Privacy: erasure, data requests, retention, the consent record, key management | ✅ Done |
| 8 | Measurements and weekly reports | ✅ Done · **your step:** approve the service levels (Q-20) |
| 9 | Bookings and the customer journey | ✅ Done |
| 10 | Consent and contact rules (who may be messaged, and how) | Next |
| 10+ | Missed-call texts, finance, complaints, offboarding, learning, hardening | Planned |
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
- **The AI model is optional and boxed in.** The rules decide first; the AI is asked only when the rules aren't sure what a customer wants, and only to pick from a fixed list. If its answer isn't valid, isn't confident, or the AI is down or slow, Sevari carries on exactly as it would without it. The AI can never by itself stop messages to someone, send a safety message or open a complaint: those labels go to you. It is called outside any database transaction, so a slow model can't hold anything up, and the instant acknowledgement never waits for it.
- **AI wording is opt-in, per message type, and fact-checked.** If you switch it on, the AI may only re-word the facts it's given (your confirmed prices, times, answers). Every word then goes through the same fact-checker; anything unsupported means the fixed template is sent instead. Building the attack tests found a real gap, now closed: a customer writing "quote me £10" could have let a reply repeat "£10". Customers' own prices and numbers are no longer accepted as facts.
- **Models are chosen by measurement, and only you can switch one on.** A benchmark (run on your VPS) scores each candidate model on your 100 test enquiries plus attack messages. Only a model that passes every gate can be promoted, only by a named person, and the database itself refuses anything else.
- **Nothing goes to a customer without a human's tap, or an earned permission.**
  - Every reply is written from your confirmed records and put in your inbox app.
  - One tap sends it, one tap lets you change it, one tap stops it.
  - The approval only works once, only for that exact message, and only for 15 minutes. Two people tapping at the same moment still sends one message.
- **Every answer you give is acknowledged at once and acted on.**
  - You see "Approved, sending now", then "Sent to the customer at 10:02", or exactly why not.
  - Silence never approves. Unanswered questions move to the next person on your list, if you set one, and you are told. At the deadline they close safely: nothing is sent.
  - If a reply is still waiting at the time you promised customers, they get one polite "still looking at it" message, and nothing else.
- **Edits are checked.** If your edit changes a fact (say a price), Sevari asks once: "just for this customer, or update your records?" It never quietly changes your records. If your records changed after a reply was written, the old reply is not sent.
- **Team members only approve what you allow.**
  - You decide which kinds of message each person may approve.
  - Veylith logins can never approve anything for your business.
  - Legal sign-offs need two named people (a lawyer and you). The app refuses to start if a settings file claims a sign-off that has no record behind it.
- **Automatic sending has to be earned and can't be forced.**
  - A kind of message can only send without asking after a clean track record of 50 messages, and only if you say yes.
  - Any complaint or failed fact check switches it straight back off.
  - Refunds, payment requests and cancellations can never be automatic: the database itself refuses.
- **Sending survives crashes.** Tests kill the worker halfway through sending, lose the provider's reply, and send duplicate webhooks. Every time, the customer gets exactly one message, or you are told it needs checking. Sevari never guesses and never re-sends blindly.
- **Your inbox app** works on a phone (tested in a real browser at phone size), loads nothing from other websites, and shows what's waiting and what happened.
- **Deleting a person really deletes them.**
  - Every customer has their own encryption key. When a customer asks to be forgotten and you approve it, Sevari sends them a confirmation, destroys their key, and deletes their records.
  - A test then searches every table in the database for any trace of them, and finds none. Copies made earlier (like backups) can no longer be read either.
  - If a backup from before the deletion is ever restored, a separate record outside the database destroys their key again before anything can use it.
  - Only the things the law needs are kept, all unreadable: the "never contact again" note, proof the request was handled, and who approved what.
- **Data requests are handled for you, on the legal clock.**
  - When someone asks for a copy of their data, or to be deleted, Sevari recognises it, sets the one-month deadline, reminds you a week before, and waits for your decision.
  - Release a copy, and the person gets a secure link that works once, for 7 days, containing only their data.
  - Refuse, and you're told exactly what you still owe them.
- **Consent is a permanent record.** Every "yes" and "no thanks" is recorded with the exact wording the person saw. The latest answer always wins, and nobody can edit or delete the history.
- **Keeping data only as long as allowed:** Sevari reports what is past its keep-by date, but deletes nothing until a lawyer confirms the periods. Deleting too early can break other legal duties.
- **Encryption keys can be rotated, revoked and recovered**, including a full drill for a suspected key leak. Tested end to end.
- **Every week you get a plain-English report**, built only from the numbers: how many enquiries came in, how fast each was acknowledged, how many replies went out, what you approved, changed or stopped, how long your decisions took, and the questions customers asked that your records couldn't answer yet (your to-do list). It's sent once per week, never twice.
- **Two numbers must always be zero, and are checked every week:** messages sent without your approval or an earned permission, and messages sent to someone who asked to stop. A test forges a bad send to prove the check catches it. The measurements obey the same walls as everything else: one business can never measure another.
- **Service levels need your approval.** The app won't let real businesses go live until you've approved the service levels (uptime, recovery time, backups: see Q-20) *and* a lawyer has signed off, each with a record in the system. Writing numbers into a settings file without the record stops the app from starting.
- **First baseline report:** 100 test enquiries across the five trades, all acknowledged except the 5 who asked to stop (who were never messaged again), with both must-be-zero numbers at zero: [`docs/reports/baseline-v1.md`](docs/reports/baseline-v1.md).
- **Every customer has a journey, and so does every business you sign up.**
  - The steps (new, enquiring, offered, booked, job done, past customer, cancelled, opted out...) are written in plain settings files, not code, and the app checks them when it starts: every step reachable, no step ambiguous, all 12 stages of the contract covered.
  - Each move is recorded once, even if the same message arrives twice, and two things happening at the same moment can't both win.
  - A step that books, sends or moves money still needs your approval or an earned permission. A step only a person may take (like signing a contract) needs a person's recorded answer. A timer can only remind; it can never approve anything.
  - Veylith's own sales journey (interested → proposal → contract → set-up → live → renewal) runs on the same engine, in Veylith's own account. Sevari asks you at each step, and you tap the answer.
- **Real bookings, with no double-booking.**
  - When a customer asks for a visit, the reply offers times from your opening hours that aren't already taken.
  - When they reply ("the first one", "Thursday at 10"), Sevari holds that time for them and writes the confirmation for you to approve. If their reply could mean two times, it asks which one. It never guesses.
  - The booking becomes real only when you approve the confirmation. If you say no, or don't answer in time, the time is freed and the customer can still pick from what they were offered.
  - The database itself refuses two bookings at overlapping times. Tested with customers grabbing the same slot at the same moment: one gets it.
  - A confirmation must state exactly the time that was held, so an edit can't quietly book a different time.
  - "Any update?" is answered from the booking itself. A cancellation always needs your tap, and approving it frees the time.
  - An hour after the job, Sevari asks you "Did it go ahead?", and your answer updates the customer's record.
- Sevari can't connect to any outside service unless you've approved that supplier. This is enforced three ways: in the code, by a gatekeeper process, and by the server's firewall (proven by a test). The supplier list (processor register) is generated automatically and currently says: no suppliers approved yet.

**Your decisions of 14 October (contract v1.12, Part L):**
- New businesses can go live within the hour: they answer the questions, an automatic checklist runs, and their own "go live" tap starts Sevari in "ask me first" mode. You only approve regulated trades.
- You decide product and build exceptions; each business owner decides their own, and can add their own team members with their own logins. Silence still never approves, and Veylith never approves for a business.
- Sevari is for any service business, not one type: onboarding builds a pack for each new kind of business, which the owner confirms. Sevari finds its own customers within the law: answering Veylith's own enquiries, approved content, opted-in leads. Cold outreach stays off until a lawyer signs off.
- FORGE (the code agent) is deferred until there's a GPU server.
- **Free to run until Sevari earns money** (Part M): every paid service has a free option used by default, and the paid one is switched on only when revenue covers it and you approve. The only fixed cost is the server (about £31 a month).
- **Texts are for paying customers only.** Before that, everything runs on free channels: email, web forms, the chat widget and phone-app notifications.
- **HIVE** is the name for Sevari's self-learning. It's in the contract and comes in later phases. It proposes, tests, and only switches things on with approval (you for the product, the owner for their own business).
- **Integrations (CIL)**: calendars, trade job software, accounting, then CRM and helpdesk (HubSpot, Zendesk and more), all planned. Each business connects its own account, so it's free for you. Sevari keeps its own records and keeps working if any of them disconnects.
- **Self-improving knowledge**: questions Sevari can't answer become one question to the owner, old prices get re-checked, and disagreements with other systems become a proposal, never a silent change.
- **Growth**: the free "How fast do you reply?" check, and referral rewards paid only after the new customer has paid twice.
- How your original vision lines up with the contract: [`docs/reference/original-vision.md`](docs/reference/original-vision.md) §7.

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
  crypto/             KMS port and KEK ring (rotate, retire, revoke), envelope encryption with a key per business and per person, blind indexes, re-wrap, crypto-shred
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
  approvals/          single-use, expiring, digest-bound approvals (§7.1), consumed in one statement
  autonomy/           reserved decisions (frozen), never-grantable classes, earned grants, kill switch (§7.2, INV-11)
  hitl/               structured questions, answers, acknowledgements, effect receipts, escalation sweep (§30, §74)
  identity/           tenant user and operator credentials, platform decisions, two-person sign-offs (§71, §82)
  privacy/            erasure registry, per-person crypto-erasure, data-rights requests and copies, consent ledger, retention reports, shred register, key drills
  lifecycle/          the journey engine: lifecycles as data (config/lifecycles), validated; idempotent, audited, authority-checked transitions; timers
  metrics/            measurement views (row-level security applies), weekly owner report, the two must-be-zero floors
  llm/                model layer: provider port (Ollama via egress, VSAP stub, fake), versioned prompts, schema-checked tasks, registry selection, grounded model drafts
apps/worker/          queue runner (NOTIFY wake-up, bounded concurrency); inbound.process; ack.send; enquiry.respond; draft.dispatch; outbox.reconcile; hitl.sweep; answer consumers
eval/                 100-case labelled corpus, knowledge fixtures, runner, reports, accepted baseline
eval/models/          model benchmark (run on the target box), injection set, BENCHMARK.md, results/
apps/api/             Fastify server: /v1/inbound/:channel/:publicId, health, CORS for forms, rate limits; owner API (/v1/owner/*), platform decisions, the owner inbox app (/app)
ops/nftables/         default-deny outbound firewall + a namespace test that proves it
config/
  regions/uk.yaml     UK rule pack (counsel_signoff: null until counsel signs)
  egress.allowlist.yaml   default deny; each host names an approved processor
  processors.yaml         structured processor registry (§69); generates docs/PROCESSOR_REGISTER.md
  lifecycles/             Lifecycle T (customer) and Lifecycle V (business, on the house tenant), as data
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

### Model layer (Phase 5)
- **Port:** `LlmProvider.generate(request)` with a JSON schema for the output. Ollama (structured `format`, temperature 0, fixed seed, warm keep-alive, capped context) goes through the egress client to an allowlisted in-cell host over TLS. The VSAP gateway is an interface that throws `NotImplemented`. A fake provider drives tests.
- **Tasks:** `classifyIntent` (enum-constrained; invalid, low-confidence or failed → abstain) and `wordReply` (facts bundle + style → text). Prompts are versioned (`classify_intent@1`, `word_reply@1`); customer text is fenced as data and forged delimiters are stripped.
- **Fallback only:** `inboundHandler` reads (tx 1), asks the model only if the rules abstained and the registry has an active model within the latency budget (no transaction open), then analyses and writes (tx 2). Model labels of `opt_out`, `emergency`, `data_rights` or `complaint` route to a human. Lineage (`intent_model_id`, `intent_prompt_id`) is on the enquiry and in the audit event.
- **Wording:** `modelDraft` is opt-in per intent; the output must pass `ground()`, otherwise the template is used. `factsBundle()` builds the model's facts and grounding's fact texts from the same analysis, so they can't drift apart.
- **Registry:** `model_registry` (migration 0005) is cell configuration: the app reads its own region's rows only; the owner role writes. `selectModel()` picks the best-scoring active model for the task and language within the latency budget, deterministically, and says why each other model was passed over. A CHECK refuses `active` without an approver, a benchmark file and a measured speed.

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
pnpm models:bench --fake            # exercise the model benchmark without a model server
pnpm models:bench --base-url … --model …   # the real run, on the target box (docs/ops/model-benchmark.md)
pnpm models:registry list|register|promote|retire   # owner role; promotion needs --by "<name>"
```

### CI (`.github/workflows/ci.yml`)
- `secrets`: gitleaks on the full history (INV-10).
- `gate`: typecheck, lint (with the contract rules), fallback secret scan, and the gate suite against Postgres 16.
- `contract-progress`: every contract test, red included, plus the status table. Informational.

### Contract test status
Run `pnpm contract:status` for the live table. After Phases 6, 7, 8, 9 and 18: T-LC-1–4, T-BOOK-1–3, T-SLO, F5, T-KEY-1–4, F6, F8, T-RES, T-CHAOS, F22–F27, F46–F58 and T-SIGNOFF join F1 (database and API), F3 (grounding, property-based), F3H (holdout harness; starter cases only, DEV-009), F7 (ACK latency), F2 (static, client, proxy, firewall), F4, T-AUD, T-BOOT, T-MIG, T-IDEM, T-PROC, T-LLM, T-LINT and T-SEC are green; every other F/T test exists and is red until its phase is built.

### Documents
- [`docs/BUILD_CONTRACT.md`](docs/BUILD_CONTRACT.md): the binding contract (v1.13)
- [`docs/ops/model-benchmark.md`](docs/ops/model-benchmark.md): how to benchmark and switch on a model on the VPS
- [`docs/CONTRACT_REVIEW.md`](docs/CONTRACT_REVIEW.md): proposed amendments
- [`docs/readiness/README.md`](docs/readiness/README.md): Production Readiness, the full stress-test campaign, and the Value Gate
- [`docs/security/key-management.md`](docs/security/key-management.md): the honest key threat model
- [`docs/privacy/backups-and-erasure.md`](docs/privacy/backups-and-erasure.md): how erasure reaches backups
- [`docs/reports/baseline-v1.md`](docs/reports/baseline-v1.md): the first measured baseline (Phase 8)
- [`docs/CAPABILITY_MATRIX.md`](docs/CAPABILITY_MATRIX.md): what's needed for pilots, for launch, or deferred
- [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md): every difference from the contract, with reasons
- [`docs/QUESTIONS_FOR_DAN.md`](docs/QUESTIONS_FOR_DAN.md): open decisions
- [`docs/reference/original-vision.md`](docs/reference/original-vision.md): your original Synchronicity / Operion vision mapped to the contract
- [`docs/reference/v4.1-behaviours.md`](docs/reference/v4.1-behaviours.md): behaviours and defects from the n8n builds
- [`docs/adr/`](docs/adr/): architecture decisions (dependencies, Temporal-ready workflow port)
