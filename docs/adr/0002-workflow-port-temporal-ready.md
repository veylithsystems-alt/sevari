# ADR-0002: A workflow port shaped for Temporal, implemented on Postgres in v1

Status: decided by Dan in this session ("Temporal-ready, not Temporal yet"). Date: 2026-10-13.

## Context
Contract §4: a Postgres-backed queue (`graphile-worker` or `pg-boss`), no Redis, the queue behind an interface. Dan's direction: n8n first, Temporal.io later. The 16GB VPS also runs Postgres and the API; a Temporal server (frontend, history, matching, worker services plus its own persistence) is a lot to add to that box.

## Decision
Define `WorkflowPort` with Temporal's model, not a plain queue's:
- **Workflows**: deterministic orchestration code that receives an injected Clock and ids, with no I/O of its own.
- **Activities**: the only place I/O happens, idempotent, keyed by `(workflow_id, step)` (contract §5.2), retried with backoff.
- **Timers**: durable (SLA clocks, cool-downs, quiet hours, retention).
- **Signals**: how human input (§30) and provider webhooks reach a waiting workflow.
- **Queries**: read a workflow's state for the owner UI.

v1 implementation: an in-repo Postgres queue (`job_queue`, DEV-007) with leases, retries and dead-lettering, claimed by the `sevari_worker` role (which can see queue rows only) and executed as the app role inside the tenant scope. Workflow state, step results and timers follow in a `workflow_runs` table, all tenant-scoped under RLS.

## Consequences
- Moving to Temporal means writing a Temporal adapter and running both engines side by side per tenant during migration. No business logic changes.
- The lifecycle engine (§16) and human-input closure (§30) map one-to-one onto workflows and signals.
- Temporal Cloud would be a processor; self-hosted Temporal would be in-cell infrastructure. Either needs its own ADR and allowlist entry.
