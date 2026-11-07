/**
 * Records Dan's approval of the cell's service levels (Part J §70, Q-20) and writes them into
 * config/slo.yaml, in one step, with his own founder credential. Run once on the server:
 *
 *   SEVARI_DATABASE_URL=<app role URL> node scripts/approve-slo.ts --token op_... [--region uk] [--config config]
 *
 * The token is read from the command line or SEVARI_OPERATOR_TOKEN and never stored. Without a founder
 * credential nothing changes. The boot check "slo" then sees both the values and the record.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SystemClock } from '@sevari/clock';
import { connect } from '@sevari/db';
import { authenticate, platformDecision } from '@sevari/identity';
import { APPROVED_SLO_2026_10_21, withServiceLevels } from '@sevari/region';

const { values: v } = parseArgs({ options: { token: { type: 'string' }, region: { type: 'string', default: 'uk' }, config: { type: 'string', default: 'config' } } });
const url = process.env['SEVARI_DATABASE_URL'];
const token = v.token ?? process.env['SEVARI_OPERATOR_TOKEN'];
if (!url) throw new Error('set SEVARI_DATABASE_URL (the application role)');
const clock = new SystemClock();
const h = connect(url);
try {
  const cred = await authenticate(h.db, clock, token);
  if (!cred || cred.kind !== 'operator' || cred.role !== 'founder') throw new Error('a founder operator token is needed: approving service levels is the founder\'s decision');
  const path = join(v.config, 'slo.yaml');
  const next = withServiceLevels(await readFile(path, 'utf8'), APPROVED_SLO_2026_10_21);
  const s = APPROVED_SLO_2026_10_21;
  const expires = new Date(clock.nowMs() + 365 * 86_400_000).toISOString().slice(0, 10);
  await platformDecision(h.db, cred, {
    decision: 'signoff', subjectRef: `cell:${v.region}:slo`, scope: `cell:${v.region}:slo`, expiresOn: expires,
    reason: `Service levels approved: availability ${s.availability_target_percent}%, RTO ${s.rto_minutes} min, RPO ${s.rpo_minutes} min, backups every ${s.backup_frequency_hours} h, ${s.restore_acceptance}`,
  });
  await writeFile(path, next);
  console.log(`Recorded. ${path} now holds the approved service levels (approval expires ${expires}; re-approve yearly).`);
} finally {
  await h.close();
}
