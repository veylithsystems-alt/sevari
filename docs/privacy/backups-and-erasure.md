# Backups and erasure (F5 "backups policy noted", §6.3, §21.2, F35)

## How erasure works in Sevari
- **Every person has their own encryption key.** Everything about them (their messages, our replies to
  them, the analysis of their enquiries, drafts, questions to the owner about them, their copy of their
  data) is sealed with that key.
- **Erasing a person destroys that key first.** From that moment, every copy of their data is
  unreadable, wherever it is: database tables, leftover pages on disk, the database's write-ahead log,
  replicas and **backups**. Nobody can reverse this, including Veylith. The database itself refuses to
  bring a destroyed key back.
- **Then their rows are deleted.** Their contact record and everything hanging off it (conversations,
  messages, analyses, drafts, approvals, outbound messages and consents) is removed. Decision records keep
  their shape (who approved what, and when) but their content is unreadable and their digests are zeroed.
- **What is kept, and why** (none of it is readable personal data):
  - opt-out suppressions (a keyed blind index), so they are never contacted again by mistake;
  - the request record (dates and outcome), as proof it was handled on time;
  - tamper-evident audit events (ids and codes only);
  - an erasure log (ids and keyed blind indexes), so the erasure can be re-applied after a restore.
- **A certificate** is recorded for each erasure: what was deleted, what was kept and why.

## Backups
- Backups are encrypted, kept in the same region as the live data, and retained for a fixed window
  (**proposal: 35 days**; counsel and Dan confirm, Q-19).
- A backup taken before an erasure still contains that person's ciphertext. It cannot be read, because
  the key was destroyed. The key's tombstone in a backup is the destroyed version too, unless the backup
  predates the erasure: then the restore procedure must run the re-apply step below **before the
  restored database serves any traffic**.
- **Restore procedure (part of PR-2, drilled before the first pilot):**
  1. Restore into an isolated database, with no traffic.
  2. Run `reapplyErasures` for every tenant: every person in the erasure log who reappears is erased
     again and their key destroyed again (tested in F5).
  3. Re-apply tenant closures (crypto-shred of the tenant's keys) from the platform record.
  4. Only then switch traffic over. The restore and the re-application are recorded.
- The KMS master key (the key that wraps every other key) is backed up separately under §67. Destroyed
  person keys are not recoverable from it: they are destroyed at the wrapped-key level, and the database
  never stores an unwrapped key.

## Closing a business (§21.1)
Every key of the business is destroyed (its data key, its blind-index key and every person key), after
the export and the statutory retention hold. Everything of theirs, in every copy, becomes unreadable. The
final erase is a human decision (§8.3).

## Open questions for counsel (UNKNOWNs, §13.4)
- The backup retention window, and whether crypto-erasure of backup contents meets the erasure duty
  without rewriting the backups (Q-19).
- Retention periods for each record type: every period in the registry is a hypothesis (status `H`).
  Until counsel confirms them, retention runs **report only** and delete nothing (Q-19).
