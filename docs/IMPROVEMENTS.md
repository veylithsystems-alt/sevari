# Improvements register

Sevari is built to the contract (`docs/BUILD_CONTRACT.md`). Building it often shows a better way. This register makes sure every improvement found along the way is **built in properly**, not left as a note, and that the build stays ready for the ones still to come.

## How an improvement is handled

1. **Built and proven.** It goes in as code with an automatic test that would fail if it were undone, in the same change.
2. **Recorded against the contract.**
   - If it is stricter than the contract and loosens nothing, it is built straight away and listed here.
   - If it differs from the contract's wording, it also goes in `docs/DEVIATIONS.md`, with the proposed contract wording.
   - If it needs Dan's decision, it goes in `docs/QUESTIONS_FOR_DAN.md` with a recommendation, and nothing is assumed.
3. **Explained.** The README's plain-English summary is updated, so Dan sees it without reading code.
4. **Never loosens a floor.** No improvement may weaken §3 (the invariants) or §8.3 (decisions that stay human). Those can only be tightened.

## Built so that later improvements slot in

Most future changes are new data or a new adapter behind an existing port, not a rewrite.

| Kind of change | Where it plugs in | Example |
|---|---|---|
| A new supplier (email, SMS, payments, accounting, calendar, model) | A port with adapters, behind the egress allowlist and the supplier register | `OutboundProvider` (Brevo, fake), `LlmProvider`, `Kms`, `PreferenceRegister`, `MoneyPort` |
| A new kind of business | Data: a trade pack, or one drafted by onboarding | `packages/verticals`, `tenant_packs` |
| A new customer or business journey step | Data: the lifecycle files, validated at start-up | `config/lifecycles/*.yaml` |
| A new country or region | Data: a region rule pack, copied into the database and checked at start-up | `config/regions/<code>.yaml` |
| A change to who may be messaged and for what | Data: contact rules and the purpose table | `regions.contact_rules`, `purpose_rules` |
| A new regulated activity | Data | `config/regulated-activities.yaml` |
| A database change | A numbered migration with an undo, tested up and down | `packages/db/migrations` |
| A change to message wording | Templates, with a version, checked by the fact-checker | `packages/templates` |

## Register

| # | Improvement | Found while | Status |
|---|---|---|---|
| I-1 | The audit hash is computed by the database, and signed checkpoints are held outside it (contract review R-4, R-5) | Phase 1 | Built, tested (T-AUD) |
| I-2 | The ACK step runs a safety and opt-out screen first, so STOP never gets an acknowledgement (DEV-008) | Phase 4 | Built, tested; contract wording proposed |
| I-3 | Customers' own prices and numbers are never accepted as facts, so "quote me £10" can't be echoed back (DEV-011) | Phase 5 | Built, tested; contract wording proposed |
| I-4 | Approval expiry uses the database clock, so a server whose clock drifts can't stretch an approval | Phase 6 | Built, tested (F6) |
| I-5 | A per-person encryption key, so erasing someone reaches copies and backups, plus a shred register outside the database for restores | Phase 7 | Built, tested (F5, T-KEY-3) |
| I-6 | The weekly report counts people who asked to stop separately, so "everyone was acknowledged" stays true | Phase 8 | Built, tested |
| I-7 | Bookings: the database refuses double-booking, and a confirmation must state the held time exactly, so an edit can't book a different time | Phase 9 | Built, tested (T-BOOK-1, T-BOOK-2) |
| I-8 | Timers can only remind; they can never authorise a step that needs a person or an approval | Phase 9 | Built, tested (T-LC-1) |
| I-9 | A provider's "try later" (rate or daily limit) is a separate outcome: nothing is sent, and it is retried rather than failed or guessed | Brevo | Built, tested |
| I-10 | The suppression floor measures from the moment a send was handed to the provider, so an opt-out racing a send is judged fairly (DEV, F9) | Phase 10 | Built, tested |
| I-11 | A do-not-call listing blocks marketing texts even with consent, until counsel says otherwise (Q-22) | Phase 10 | Built, tested (F12); counsel question open |
| I-12 | The cell refuses to start if its database copy of the contact rules differs from the region rule pack | Phase 10 | Built, tested (T-BOOT) |
| I-13 | Purpose limitation has a database backstop under the code gate | Phase 10 | Built, tested (F10) |
| I-14 | A business that isn't live sends nothing to customers, and the database refuses any go-live without a recorded decision | Phase 11 | Built, tested (T-ONB-1, T-ONB-3) |
| I-15 | Practice enquiries generated from each business's own answers found a real gap: "delete the personal data you hold about me" wasn't recognised as a data request. Fixed for every business | Phase 11 | Built, tested (eval unchanged at 94% routing) |
| I-16 | The F2 supplier scan tells cited evidence links apart from real connection targets (DEV-017) | Brevo | Built, tested; contract wording proposed |
| I-17 | Finance: erasing a person keeps the tax record but removes the link to them (§19.6), enforced by the database | Phase 12 | Built |
| I-18 | An invoice is issued (numbered, posted) only when the message sending it is authorised, so a refused invoice never uses a number and the sequence stays gapless | Phase 12 | Built, tested |
| I-19 | An invoice message must state the invoice's exact total and link, so an edit can't ask for a different amount | Phase 12 | Built, tested |
| I-20 | The database refuses an automatic payment match below the confidence threshold (F17), not just the code | Phase 12 | Built, tested |
| I-21 | A processor's "try later" and the money mode both have database guards: only Veylith's owner role can change how money flows | Phase 12 | Built, tested (F14) |

Cross-business suppression (DEV-018) is a known gap with a plan: it is built before any sender class spans businesses.

### Added in Phase 13

| # | Improvement | Status |
|---|---|---|
| I-22 | Suspension for non-payment is guarded by the database: it needs Dan's recorded decision, so no bug or automation can suspend a business (§8.3) | Built, tested (T-BILL-2) |
| I-23 | A plan version is usable only with an approval record; an unapproved price is ignored even if it's newer | Built, tested (T-BILL-3) |
| I-24 | Invoice messages are fact-checked like replies: building billing showed the billing period dates must be cited from the record, or the message is blocked | Built, tested |
| I-25 | Accounting tokens get a key of their own, so disconnecting destroys every copy, including backups | Built, tested (T-ACC-2) |

### Added in Phase 14

| # | Improvement | Status |
|---|---|---|
| I-26 | Choosing a remedy drafts the exact message for approval, instead of sending text the owner hasn't seen: an approval only ever covers the words a person saw (§7.1) | Built, tested (T-CMP-2) |
| I-27 | The customer journey no longer asks its own "is it resolved?" question alongside the complaint case: one case, one owner, one clock | Built (lifecycle files v3/v2) |
| I-28 | A customer flagged for extra care is protected at the point of sending, so no path, including earned permissions, can send to them automatically | Built, tested (T-CMP-4) |
| I-29 | The database refuses an open complaint without an owner, or a closed one without a root cause | Built, tested |

### Added in Phase 15

| # | Improvement | Status |
|---|---|---|
| I-30 | The database refuses a partner who processes data for a business unless a data processing agreement is on record, so a handover can't go to a processor without one | Built, tested (F19) |
| I-31 | A refused handover is recorded in the tamper-proof record even though nothing was shared, so refusals can be audited | Built, tested (F19) |
| I-32 | Checking the contract line by line found two gaps: leaving had no final bill, and a business couldn't change its mind. Both built: a final bill for the days used, then the subscription ends; cancelling during the notice stops both the bill and the deletion | Built, tested |
| I-33 | The erasure certificate lists what was kept and why (tax records, with no link to any person), not just what was deleted | Built, tested (F21) |
| I-34 | Switching off a team member's login hands their open cases to the owner in the same step, so a case can never be left without an owner | Built, tested (T-OFF-1) |
| I-35 | Customer portal links are stored only as a scrambled copy and expire, and the page loads nothing from anywhere else and runs no scripts | Built, tested |

### Added with sign-up and sign-in

| # | Improvement | Status |
|---|---|---|
| I-36 | **Security fix:** building sign-out showed that a revoked login key (or a revoked Veylith operator key) still worked, because sign-in never checked whether it had been revoked. Revoked keys are now refused at the lookup | Built, tested |
| I-37 | Sign-up keeps nothing until the email is confirmed: the typed details are encrypted, destroyed when used or after 24 hours, and the database refuses a used request that still holds them | Built, tested |
| I-38 | Sign-up and sign-in answer the same way whether or not an address has an account, and send at most a few emails to any address an hour, so the form can't be used to find out who uses Sevari or to flood someone's inbox | Built, tested |
| I-39 | Sign-up records which version of the terms each business agreed to, and is refused if the terms changed while the page was open | Built, tested |
| I-40 | Account emails carry a sign-in link, so they are encrypted while waiting and destroyed once handed to the email provider | Built, tested |
| I-41 | The owner sees every drafted record in plain English before confirming, not just a count, so a confirmation always covers words they have read (I5) | Built, tested (browser) |
| I-42 | The website enquiry form is a copy-and-paste snippet with a tiny script: no cookies, no tracking, nothing from anywhere else; a double-click can't send an enquiry twice | Built, tested |
| I-43 | Owners can type "mysite.co.uk"; Sevari adds the secure https themselves rather than refusing the address | Built, tested (browser) |
| I-44 | The brief's email says only how many things need the owner, never what they are, so no customer detail travels by email; the brief itself stays in the app | Built, tested |
| I-45 | Briefs start the moment a business goes live, and the 7am/7pm times follow the business's own clock changes | Built, tested |
