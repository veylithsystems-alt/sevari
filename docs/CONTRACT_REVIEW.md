# Build contract review: proposed amendments for v1.10

Reviewer: Claude Code, 13 October 2026, against `docs/BUILD_CONTRACT.md` v1.9, the Product Brief, Design Brief v2.2, Architecture v2.3 and the n8n builds v3.6.0 / v4.1.0.

**Only Dan amends the contract (§14).** Nothing here is in force. Each item is a proposal with the reason, what changes, and whether it's constitutional (touches §3 or §8.3). Items marked **[built]** are already implemented on the branch because they're stricter than the contract and loosen nothing (Part C lets later work tighten §3 but never loosen it). Dan can still reject them.

> **Update 13 Oct 2026:** Dan's own amendments are now in the contract as **Part J (v1.10)**: three finished states (build-complete, production-approved, commercially launched), a Production Readiness phase, a Value Gate, the billing split and capability matrix, delivery-ambiguity tests F46–F50, an honest key-management threat model (T-KEY-1..4), the adversarial holdout corpus (F3H), a structured processor registry, approved SLO/RTO/RPO, and precise legal controls. Where my proposals overlap, Part J wins: R-11 is covered by §66/§68, R-16 by §70. The rest below are still proposals.

Legend: **R** = recommendation, **Q** = needs Dan's decision (see `docs/QUESTIONS_FOR_DAN.md`), **C** = constitutional.

---

## 1. Things that are broken or missing in the contract itself

**R-1. The contract file is truncated and Appendix 2 is missing.** The file ends mid-sentence in Appendix 1 §7 ("Pilots can't start until the build reac"). Appendix 2 (Pilot pricing and outreach plan) is referenced by §42–§48 and §52 (scorecard fields, the four end-of-pilot questions, the cost floor), but isn't in the file. *Change:* restore both. Until then, the §46 qualification scorecard and the §46 price questions are built as configurable data with placeholder fields, recorded in `DEVIATIONS.md`.

**R-2. Phase numbers collide.** §11 says Phase 9+ is "billing, reminders, review requests, new channels, region #2". §25 says Phase 9 is the lifecycle engine. §51 adds Phase 9b. §38 moves Phase 18 before Phase 6 closes. *Change:* one ordered phase table that follows dependencies: 0, 1, 2, 3, 4, 5, 18 (human input), 6, 7, 8, 9 (lifecycle), 9b (missed-call), 10 … 25.

**R-3. T1–T23 can't be built until the resurrection review is supplied.** `docs/reference/t-mapping.md` holds the slots. *Change:* attach the review, or replace T1–T23 with the 16 defect regressions in `docs/reference/v4.1-behaviours.md` (D-1 … D-16), which come from reading the v4.1 build directly.

## 2. Security and integrity: stricter versions of what the contract asks

**R-4 [built]. The audit hash is computed by the database, not the app.** §3 INV-8 says "append-only and hash-chained". In the reference build, the stored hash covered only the enquiry id and a timestamp, so content could be changed undetected (defect D-13). *Change to INV-8:* "Hash = SHA-256(prev_hash ‖ canonical row), computed in a database trigger that ignores client-supplied values; appends serialised per chain; UPDATE/DELETE/TRUNCATE refused by trigger for every role, including the owner." **C** (tightens §3).

**R-5 [built]. Signed checkpoints anchor the audit chain outside the database.** A hash chain alone doesn't stop someone with database superuser rights from rewriting the whole chain. *Change:* add "Chain heads are signed on a schedule with an Ed25519 key held outside the database; verification checks every checkpoint." Later this can publish checkpoint hashes to the trust page (§36.5), so tenants can verify their own records independently. That's a proof competitors can't easily match. **C** (tightens §3).

**R-6 [built]. Audit rows never contain personal data.** The contract doesn't say how an immutable audit log and the right to erasure coexist. *Change:* "Audit payloads hold ids, codes, counts and digests only, enforced at write time. Erasure never alters the audit chain; the content it points at is deleted or crypto-shredded." This removes a legal conflict before it exists.

**R-7 [built]. Composite tenant foreign keys.** RLS stops reads across tenants, but a bug could still link tenant B's row to tenant A's parent id. *Change to §6.1:* "Every tenant table has UNIQUE (tenant_id, id); child tables reference (tenant_id, parent_id)." Cross-tenant references become impossible at the schema level.

**R-8 [built]. The migration owner role can't read tenant data.** With RLS forced and no policy for the owner role, the role that runs migrations sees zero tenant rows. Only human-administered tables (regions, transfer contracts) have owner policies. *Change to §6.1:* say so, and require backfills to run as tenant-scoped jobs.

**R-9 [built]. Ciphertext is bound to its location (AEAD associated data).** *Change to §6.3:* "Each ciphertext's associated data is tenant, region, table, column and row id." A ciphertext copied into another row or tenant then fails to decrypt.

**R-10 [built]. Blind indexes are keyed, with their own key.** The reference used an unkeyed SHA-256 of the email (defect D-15), which can be reversed by guessing likely addresses. *Change to §6.3:* "Blind index = HMAC with a per-tenant blind-index key, separate from the data key, derived per index kind; destroyed by crypto-shred."

**R-11. Nothing changes outbound content after the approval digest.** The reference "output guard" silently rewrote approved replies (D-6). *Add to §7.1:* "No component may modify a payload after its digest is computed. A draft that fails a check is blocked and routed to a human, never edited automatically." **C** (tightens §3 INV-4 and INV-5).

**R-12. Approval links aren't enough for consequential actions.** The v4.1 approval page could run attacker-supplied script (D-12), and anyone holding the SMS link could approve. *Add to §7.1:* approval links are single-use, expiring and digest-bound (already F6). For action classes above `info_reply`, the approver must also be in an authenticated owner session with a passkey (WebAuthn), and the approval page is served with a strict Content-Security-Policy and output escaping. This keeps "one tap" for routine replies and adds one fingerprint or face check where money or commitments are involved.

**R-13. Owner authentication uses passkeys.** *Add to §36.3:* passkeys (WebAuthn) as the primary owner login, magic links as a fallback with short expiry, no passwords. That's phishing-resistant, and it suits owners who live on their phones.

## 3. Future-proofing

**R-14. Make the queue port a durable workflow port shaped for Temporal.** Your stated direction is n8n, then Temporal. §4 already says "queue behind an interface". *Change:* define a `WorkflowPort` with Temporal's semantics: durable workflows, activities that are idempotent and retried, timers, and **signals** for human input. The v1 implementation stays Postgres-backed (`graphile-worker`, no new infrastructure on the 16GB box). The lifecycle engine (§16) and human-input closure (§30) are written against the port, so moving to Temporal later means swapping an adapter, not rewriting. Recorded as ADR-0002.

**R-15. Plan the move to Node 24 LTS.** §4 pins Node 22 LTS. My understanding is that Node 22 leaves active LTS for maintenance and reaches end of life in 2027; I haven't verified the exact dates. *Change:* "Node: the current Active LTS at each phase; the repo pins one version." The code avoids anything version-specific, so the move costs one line.

**R-16. A performance harness the target box runs, with results committed.** F7 and F45 must be measured "on the 16GB box". CI runners aren't that box. *Change:* `pnpm perf` runs on the target box and writes `eval/perf/<date>.json`; the PR quotes it. CI runs the same harness at reduced load as a smoke test only.

**R-17. Time-zone and clock-change tests.** Quiet hours, sending windows and SLA clocks are tenant-local. *Add:* property tests across UK clock changes (BST↔GMT) for every window, cooldown and deadline. The 01:00–02:00 hour that repeats or disappears is a classic source of double or missed sends.

**R-18. Supply-chain specifics.** *Add to §36.3:* an exact-version lockfile (done), install scripts disabled except an allowlist (done: only `esbuild`), a licence check in CI, an SBOM generated per build, and a rule that dependency updates arrive as their own PRs.

**R-19. Audit in its own trust boundary.** From the Synchronicity design (separate audit database): move the audit tables into a dedicated schema owned by a dedicated role, so neither the app nor the migration role can alter them, and back the audit up separately. *Change:* add to INV-8. **C** (tightens §3).

**R-20. Companies House pre-fill at onboarding.** From the vision's EKP enrichment: the owner enters a company number and the system drafts knowledge records (registered name, address, SIC codes) **for the owner to confirm** (§18). This automates a real chore lawfully, using a public register about the tenant's own business. *Change:* add to §18; it needs a provider ADR (Companies House API) and an allowlist entry.

**R-21. Approvals in the owner app first, SMS as fallback.** The briefs promise "one tap on your phone". An SMS per approval costs money on every enquiry (Part G). The owner app (PWA, §36.1) with web push gives the same one tap for free. *Change:* in §7.1 and Phase 6, approvals are delivered by push first and by SMS only if push isn't acknowledged within the owner's chosen delay or the owner prefers SMS. SMS replies (`APPROVE <code>`) stay valid for low-risk classes only, single-use and sender-checked (vision §4).

**R-22. Veylith as tenant zero.** The Product Brief's "talk to Sevari herself on the website" becomes a rule: Veylith's own enquiries run through Sevari as the house tenant (`is_house`), under the same rules, approvals and audit as every customer. It is the live demo, the first source of real (Veylith-owned) traffic, and an early warning system. *Change:* add to Part E and Phase 11.

**R-23. Delegates (from the Product Brief).** An owner can name delegates and the action classes each may approve. Unanswered approvals move to the next delegate after a delay the owner sets; a delegate must actively approve (INV-14, §74 unchanged); every hand-over is acknowledged to the owner. Money classes stay owner-only unless the owner grants them explicitly. *Change:* add to §7.1 and §74 (pending Q-17).

**R-24. Claims wording from the briefs.** Ten absolute statements in the briefs need rewording before any public page (`docs/reference/original-vision.md` §7.3). *Change:* seed the §43 claims register with them, each with its evidence or its "do not publish until counsel confirms" status.

## 4. Product and law: items that need a decision, not code

**Q-1. The seven agents (BASTION, SENTINEL, HERALD, VANGUARD, COMPASS, LEDGER, FORGE).** The briefs sell seven named agents. The contract never mentions them. My mapping:
- BASTION = the enquiry pipeline (§5): covered.
- SENTINEL = reliability and ops (§36.2): covered.
- LEDGER = finance (§19): covered, Mode 1 only.
- VANGUARD = lifecycle follow-ups (§16–§17): covered, Tiers A/B only.
- HERALD (writes and posts marketing; "researches AI pain points online") and COMPASS (market intelligence; "compliance scrape") involve crawling the web and publishing. They touch §17.1 Tier E, site terms and the claims register (§43). They're not in the contract.
- FORGE ("builds and deploys code at the user's direction") is a different product with a very different risk profile.

*Decision needed:* keep the names as product branding mapped to contract modules, and decide whether HERALD, COMPASS and FORGE are in scope. My recommendation: keep the names; add HERALD as approval-only content drafting from the tenant's own data plus the claims register, with no crawling; defer COMPASS and FORGE to their own contracts.

**Q-2. Pricing conflict.** The briefs: £149 / £349 / £699 / £1,299 a month **including VAT**, "no per-message fees". The contract (Part E): a £59 founding rate **excluding VAT where applicable**, after a free pilot. Pricing is data (§47), so the code doesn't care, but the trust page and invoices must show one truth. *Decision needed:* which list is current.

**Q-3. T0 desktop GPU via Cloudflare Tunnel.** The Architecture brief puts a home desktop GPU in the response path through Cloudflare. Under the contract that makes Cloudflare a processor of customer content, and puts a home machine outside the processor register and the cell boundary. *Recommendation:* drop it, or treat the desktop as a registered, encrypted, cell-internal inference host reached over WireGuard rather than a third-party tunnel, with its own ADR.

**Q-4. Legal changes to check with counsel.** I can't verify these, so they're UNKNOWNs (§13.4), not facts:
- The **Data (Use and Access) Act 2025** amends UK GDPR and PECR in stages. Areas to check: automated decision-making (Art. 22, which §8.3 and §17.2 rely on), PECR fine levels, the soft opt-in, and any new duty to run a data-protection complaints procedure (which would fit the §20 complaints workflow).
- The **EU AI Act** transparency duties for systems that interact with people (relevant to the AI-drafted disclosure, §8.4) apply from a date in 2026 that counsel should confirm. This matters once there's an EU cell.
- **Entity status:** the contract says Veylith is a sole trader; the Design Brief says "Veylith Systems Ltd (incorporating)". This affects contracts, the ICO fee, the Twilio regulatory bundle (§57.5) and the PECR treatment of Veylith's own marketing.

**Q-5. "She learns your business" vs governed learning.** The briefs promise learning "by paying attention". The contract (§31–§35) allows learning only through proposals, evaluation and a human gate, with everything off until the learning gate (§35). The contract is the safer promise. *Recommendation:* update the brief's wording to "she proposes improvements you approve", which is true and still a selling point.

## 5. Already decided by Dan and built as decided

D1 (Mode 1 money only), D3 (Tiers A and B only; C–E built, tested as disabled; F disabled in code), D4 (learning permitted in design, off until the gate), and the Temporal-ready queue (answer given in this session). Pushing to a branch rather than one PR per phase was also Dan's instruction in this session; it is recorded as DEV-001.
