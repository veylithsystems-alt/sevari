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

## Value Gate (§64), before wider commercial launch

| Gate | Evidence | Status |
|---|---|---|
| Product value | Pilot outcomes vs each business's own pre-pilot baseline | not started |
| Owner workload | Measured owner minutes (corrections, UNKNOWNs, data upkeep) vs time saved | not started |
| Reliability | Acceptance corpus + holdout + pilot evidence meet approved criteria | not started |
| Unit economics | Cost per resolved enquiry and per customer, measured, no H values | not started |
| Retention | Continued use and a signed paid plan or deposit | not started |
| Operational readiness | §63 complete | not started |
