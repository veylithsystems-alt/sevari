/**
 * Retention (§6.4, §27.7). Every table has a retention period in the registry. While a period is a
 * hypothesis (status 'H'), the run only REPORTS what would be removed: deleting early could break a legal
 * duty to keep records, and deciding that is counsel's job, not code's. Once counsel confirms a period,
 * the same run enforces it. Report-only today for every table.
 */
import type { Clock } from '@sevari/clock';
import { sql, type TenantTx } from '@sevari/db';
import { ERASURE_REGISTRY } from './registry.ts';

export interface RetentionFinding {
  readonly table: string;
  readonly days: number;
  readonly status: 'H' | 'counsel_confirmed';
  readonly overdue: number;
  readonly action: 'report_only' | 'enforced';
}

/** Tables whose period runs from creation and that hold tenant rows; others need relationship-end logic (Phase 9). */
const BY_CREATION = ['reply_records', 'job_queue', 'human_notifications', 'drafts', 'human_questions', 'user_tokens'] as const;

export async function retentionRun(deps: { clock: Clock }, tx: TenantTx): Promise<RetentionFinding[]> {
  const findings: RetentionFinding[] = [];
  for (const table of BY_CREATION) {
    const e = ERASURE_REGISTRY[table];
    const days = e?.retention.days;
    if (!e || days === null || days === undefined || e.retention.trigger !== 'created') continue;
    const cutoff = new Date(deps.clock.nowMs() - days * 86_400_000);
    const overdue = Number((await tx.selectFrom(table).select(sql<string>`count(*)`.as('n')).where('created_at', '<', cutoff).executeTakeFirstOrThrow()).n);
    // Enforcement is deliberately not wired for 'H' periods; when counsel confirms one, it is added here with a test.
    findings.push({ table, days, status: e.retention.status, overdue, action: 'report_only' });
  }
  await tx.insertInto('retention_runs').values({ tenant_id: tx.scope.tenantId, region: tx.scope.region, ran_at: deps.clock.now(), findings: JSON.stringify({ findings }) }).execute();
  return findings;
}
