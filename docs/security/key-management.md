# Key management: the honest threat model (§67)

## The keys
| Key | What it is | Where it lives |
|---|---|---|
| **KEK** (key-encryption key, "master key") | Wraps every other key. One active per cell; older ones retired, then revoked | v1: a key file on the cell's server, readable only by the key service user. Target: separate key host, HSM or managed KMS |
| **Tenant data key** | Encrypts a business's own records (knowledge, endpoint secrets) | `tenant_keys`, stored only wrapped by the KEK |
| **Tenant blind-index key** | Makes lookups by email or phone possible without storing them readably | `tenant_keys`, wrapped |
| **Person key** (one per customer) | Encrypts everything about one person: messages, replies, analyses, drafts, questions, their data copy | `subject_keys`, wrapped |

Every ciphertext is also bound to its exact place (business, region, table, column, row), so it can't be
copied into another row or another business and still decrypt.

## What each key protects against
- **A database leak without the KEK** (a stolen backup, a leaked dump, a misconfigured replica): nothing
  is readable. Every key in the database is wrapped by a KEK that is not in the database.
- **One business reaching another's data:** blocked first by row-level security; even a bug that bypassed
  it would hand over ciphertext bound to the other business, under that business's keys.
- **Erasure:** destroying a person's key makes every copy of their data unreadable, including in backups
  and leftover disk pages. Destroying a business's keys does the same for the whole business.
- **Tampering:** encryption is authenticated; any change to a ciphertext makes it fail to decrypt.

## What they do NOT protect against (residual risk)
- **An attacker who controls the running server.** In v1 the KEK file and the database are on the same
  server. Someone with full control of that machine can use the key service and read data. Per-business
  keys limit how much one bug exposes; they are **not** a defence against a full host compromise.
  **The website, README and trust page must never describe the v1 key file as independent key security.**
- **An attacker with a valid owner sign-in** sees what that owner can see. That is what sign-in protection,
  passkeys (R-12) and team permissions are for, not encryption.

## The trust boundary (v1)
- The KEK file is owned by a dedicated system user and readable only by it. The API and worker processes
  run as other users and get unwrapping through the key service, never the file.
- Every unwrap is logged by KEK id (never the key or what it unlocked).
- **Move the KEK off the box** (separate key host, HSM or managed KMS) when either is true: the first
  paying customer outside the pilot, or more than 10 live businesses in the cell. This is a configuration
  change behind the `Kms` port, not a rewrite.

## Rotation, revocation, recovery (tested)
- **KEK rotation (T-KEY-1):** a new KEK becomes active, the old one is retired; `rewrapKeys` re-wraps every
  business and person key in place. No data is re-encrypted, nothing is lost. The old KEK is then revoked.
- **Revocation (T-KEY-2):** a revoked KEK never unwraps again, even if its file is still present.
- **Data-key rotation:** a business's data key can be rotated; new writes use the new version, old
  versions stay readable until a re-encryption job finishes.
- **Backups and restore (T-KEY-3):** backups contain only wrapped keys. Backups are encrypted with a key
  that is **not** stored on the backup host. Every key destruction is also written to the **shred
  register**, an append-only, hash-chained record kept outside the database; after a restore, the register
  is re-applied before the database serves anything, so a restore can never bring back a destroyed key.
- **KEK backup:** the KEK is backed up offline (two copies, two places, neither on the database or backup
  host). Losing every copy of the KEK means losing every business's data: this is the one irreversible risk
  and the reason the KEK has its own recovery procedure.

## Compromise response (T-KEY-4, drilled)
If a KEK may have been exposed:
1. Generate a new KEK on the key host and make it active.
2. Re-wrap every business's and person's keys (`keyCompromiseDrill` does steps 1–4 and records them).
3. Verify every business can read its data with the new KEK alone.
4. Revoke the old KEK; prove it no longer unwraps.
5. Open a breach assessment (§71): assess the risk to people; a human decides whether the regulator and
   people must be told (UK: within 72 hours of becoming aware, where required).
6. If data keys themselves may have been exposed (host compromise), rotate the data keys and re-encrypt.

The drill runs end to end in CI (T-KEY-4) and must be rehearsed on the production-shaped deployment as
part of the stress-test campaign (readiness ST-4, ST-5).
