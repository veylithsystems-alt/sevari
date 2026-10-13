# Deviations from the build contract (§13.3)

Every difference from `docs/BUILD_CONTRACT.md` v1.9, with what, why, risk and proposal. Nothing here is a quiet workaround.

| ID | What | Why | Risk | Proposal |
|---|---|---|---|---|
| DEV-001 | Work is pushed to the branch `claude/sevari-core-build` as one commit per phase, not one PR per phase (§0.3, §11) | Dan's instruction in this session ("Just push to a branch") | Phases are reviewed together, not one at a time | Dan can ask for a PR per phase at any time; each phase is a separate commit, so they split cleanly |
| DEV-002 | Contract tests for phases not yet delivered are **skipped in the CI gate** and **red in the full run** (`pnpm test:all`, CI job `contract-progress`) | §11 Phase 0 wants every test written red, and §3 wants CI to block on regressions. Both can't hold on day one: a red-by-design test would block every merge | A real regression in an undelivered phase isn't caught by the gate. Mitigation: once a phase is in `tests/contract/phases.json`, its tests are gated | Keep. Phases are added to the delivered list only when their exit criteria are green |
| DEV-003 | T1–T23 are placeholders | The v3.6 resurrection review (§2) wasn't supplied | Behaviours it covers may be missed | Supply the review, or accept defects D-1 … D-16 as the mapping (CONTRACT_REVIEW R-3) |
| DEV-004 | Local test runs use a native PostgreSQL 16 when Docker isn't available (`SEVARI_TEST_DATABASE_URL`); CI uses a Postgres 16 service container rather than Testcontainers | Docker Hub rate-limited this environment. A CI service container gives the same isolation more simply | None for correctness: each test run creates and drops its own database, and schema-altering tests get a fresh one | Keep both paths; Testcontainers is still used automatically when Docker works and no URL is set |
| DEV-005 | Appendix 2 (pilot pricing and outreach) is missing from the contract file, which is also truncated | Source file is incomplete (CONTRACT_REVIEW R-1) | The §46 scorecard fields and end-of-pilot questions can't match Appendix 2 exactly | Built as data with placeholder fields until Appendix 2 is supplied |
| DEV-006 | `schema_migrations` uses `version_no` (not `version`) for its row-version column | `version` is the migration number, a natural primary key | None | Keep; the schema lint knows this one exception |
