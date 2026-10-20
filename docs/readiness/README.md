# Production Readiness and Value Gate (contract §62–§64)

**Current state: build in progress. Not build-complete, not production-approved, not commercially launched.**

A green CI pipeline is not evidence that Sevari is ready for paying customers (§62).

## Production Readiness (§63)
Each item needs evidence in this folder and Dan's dated sign-off recorded as a human approval. **P** = required before the first pilot.

| # | Item | P | Evidence | Signed off |
|---|---|---|---|---|
| PR-1 | Deployment and rollback | P | | |
| PR-2 | Recovery meets approved RPO/RTO; erasure re-applied after restore | P | | |
| PR-3 | Security review: threat model, key-management boundary; pen test before first paying tenant | P (part) | | |
| PR-4 | Monitoring and alerting to a person | P | | |
| PR-5 | Customer onboarding end to end | P | | |
| PR-6 | Support channel and escalation | P | | |
| PR-7 | Billing arrangements (manual acceptable for pilots) | P | | |
| PR-8 | Terms, DPA, privacy notice, sub-processor list, AI disclosure | P | | |
| PR-9 | Incident and breach-assessment drill | P | | |
| PR-10 | Cancellation, export and erasure end to end | P | | |
| PR-11 | Pilot agreement and success criteria per pilot | P | | |

## Phase exits that need the target box

| # | Item | Evidence | Status |
|---|---|---|---|
| MB-1 | Model benchmark table on the 16GB VPS (§11 Phase 5 exit, §9) | `eval/models/BENCHMARK.md` + `eval/models/results/` ([how](../ops/model-benchmark.md)) | not run (DEV-010) |
| MB-2 | F7 ACK latency re-measured on the VPS while the model is busy | `eval/perf/` | build-box figure only |

## Full stress test before commercial launch (Dan, 15 Oct 2026)

A complete stress-test campaign must pass on the production-shaped deployment before Sevari is approved for
paying customers. Passing unit and contract tests is not enough. Each item needs a dated report in this folder.

| # | What is attacked | How | Pass means |
|---|---|---|---|
| ST-1 | Load and capacity | Ramp from normal to 10× expected peak enquiries, with the model busy and a slow provider | ACK p95 within target at expected peak; graceful degradation (never silence) above it; no data loss |
| ST-2 | Soak | 72 hours at expected load | No memory growth, queue growth, lease leaks or rising latency |
| ST-3 | Chaos | Kill the database, worker, model host, proxy and network mid-flow, repeatedly | No double send, no lost enquiry, no silent approval; recovery within RTO |
| ST-4 | Security | External penetration test, prompt-injection suite (F36, ≥200 cases), credential and tenant-boundary attacks | No cross-tenant access, no ungrounded send, no credential misuse |
| ST-5 | Data protection | Erasure, data-copy and restore drills on production-shaped data | Nothing readable after erasure, including from a restored backup |
| ST-6 | Human flows | Owners and team members on real phones: approvals, edits, escalations, silence, wrong person | Every input acknowledged and acted on; silence never sends |
| ST-7 | Provider failure | Email and SMS providers timing out, duplicating, rejecting | One message or a clear owner task, every time |
| ST-8 | Commercial | Pilot-scale run with real businesses (Value Gate evidence) | Value Gate criteria met |

## Value Gate (§64), before wider commercial launch

| Gate | Evidence | Status |
|---|---|---|
| Product value | Pilot outcomes vs each business's own pre-pilot baseline | not started |
| Owner workload | Measured owner minutes (corrections, UNKNOWNs, data upkeep) vs time saved | not started |
| Reliability | Acceptance corpus + holdout + pilot evidence meet approved criteria | not started |
| Unit economics | Cost per resolved enquiry and per customer, measured, no H values | not started |
| Retention | Continued use and a signed paid plan or deposit | not started |
| Operational readiness | §63 complete | not started |
