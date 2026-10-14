# Capability matrix (contract §65)

Every capability is **Pilot** (needed for the first pilots), **Launch** (needed before commercial launch, §64) or **Deferred**. Proposed by Claude Code; **Dan confirms**. Anything marked "Q" waits on a decision in `QUESTIONS_FOR_DAN.md`.

| Capability | Contract | Class | Note |
|---|---|---|---|
| Inbound web form, email, SMS intake | §5.2, Phase 2 | Pilot | |
| Instant deterministic acknowledgement | §5.2, Phase 4 | Pilot | |
| Rules-first triage, slots, eligibility, price-from-records, "price on inspection" | §5.3, §42, Phase 3 | Pilot | |
| Grounded drafts in assist mode, owner approval inbox | Phases 4–6, 18 | Pilot | |
| Missed-call text (Design B divert) | Part F | Pilot (opt-in per pilot) | after Twilio ADR + counsel |
| Privacy: erasure, DSAR assembly, retention, consent ledger | Phase 7 | Pilot | |
| Weekly pilot report, metrics, cost views, operator time log | §46, §54, Phase 8 | Pilot | |
| Tenant export and exit | §21.1 | Pilot | needed for PR-10 |
| **Veylith subscription billing** | §19.4 | Pilot = **manual**; Launch = automated | §65: no billing platform before demand is validated |
| **Tenant-side invoices, payment links, chasing** | §19.2 | Launch | Mode 1 only (D1) |
| Reconciliation, bank feed, accounting sync | §19.3, §19.5 | Launch / Deferred | bank feed Deferred |
| Complaints and disputes workflow | §20 | Launch (holding ACK + escalation is Pilot) | |
| Graduated autonomy grants | §7.2 | Launch | pilots are assist-only (§43) |
| Governed learning | §31–§35 | Deferred | behind the learning gate |
| Outbound Tiers C–E | §17 | Deferred | D3 |
| Voice, WhatsApp, chat widget, marketplace adapters | §36.1 | Deferred | voice excluded from v1 |
| Region #2 | §1 | Deferred | |
| Every human input acknowledged and confirmed; customer holding update | §74 | Pilot | |
| Morning brief / evening summary | §78 | Pilot (morning brief) / Launch (evening) | |
| Agent Mode framework, SENTINEL | Part K, K1 | Launch | |
| LEDGER agent | K2 | Launch | over Part B finance |
| VANGUARD agent | K3 | Launch | Tiers A/B only |
| HERALD agent | K4 | Launch or Deferred | Dan decides (§80) |
| COMPASS agent | K5 | Deferred | source register + counsel |
| FORGE agent | K6 | Deferred | Dan decides (§80) |
