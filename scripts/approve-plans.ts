/**
 * Records Dan's approval of the plans in config/plans.yaml (§47: a price change is a data change with an
 * approval record) and writes them into the cell. Founder credential only.
 *
 *   SEVARI_DATABASE_URL=<app role> SEVARI_OWNER_DATABASE_URL=<owner role> node scripts/approve-plans.ts --token op_... [--region uk]
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { parse } from 'yaml';
import { z } from 'zod';
import { SystemClock } from '@sevari/clock';
import { connect } from '@sevari/db';
import { authenticate, platformDecision } from '@sevari/identity';

const Plans = z.object({ version: z.literal(1), plans: z.array(z.object({
  plan_key: z.string().regex(/^[a-z][a-z0-9_]*$/), plan_version: z.number().int().positive(), name: z.string().min(1), price_minor: z.number().int().min(0), currency: z.string().length(3),
  vat_treatment: z.enum(['inclusive', 'exclusive', 'not_registered']), allowances: z.object({ enquiries: z.number().int().min(0), seats: z.number().int().min(1), channels: z.number().int().min(1) }),
  overage_per_enquiry_minor: z.number().int().min(0), effective_from: z.string().date(),
})).min(1) });

const { values: v } = parseArgs({ options: { token: { type: 'string' }, region: { type: 'string', default: 'uk' }, file: { type: 'string', default: 'config/plans.yaml' } } });
const appUrl = process.env['SEVARI_DATABASE_URL'];
const ownerUrl = process.env['SEVARI_OWNER_DATABASE_URL'];
if (!appUrl || !ownerUrl) throw new Error('set SEVARI_DATABASE_URL and SEVARI_OWNER_DATABASE_URL');
const plans = Plans.parse(parse(await readFile(v.file, 'utf8')));
const clock = new SystemClock();
const h = connect(appUrl);
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
try {
  const cred = await authenticate(h.db, clock, v.token ?? process.env['SEVARI_OPERATOR_TOKEN']);
  if (!cred || cred.kind !== 'operator' || cred.role !== 'founder') throw new Error('a founder operator token is needed: prices are the founder\'s decision');
  const summary = plans.plans.map((p) => `${p.plan_key} v${p.plan_version} ${p.currency} ${(p.price_minor / 100).toFixed(2)} (${p.vat_treatment}) from ${p.effective_from}`).join('; ');
  const decisionId = await platformDecision(h.db, cred, { decision: 'signoff', subjectRef: `plans:${v.region}`, scope: `plans:${v.region}`, reason: `Plans approved: ${summary}`, expiresOn: new Date(clock.nowMs() + 365 * 86_400_000).toISOString().slice(0, 10) });
  for (const p of plans.plans) {
    await owner.query(`INSERT INTO plans (region, plan_key, plan_version, name, price_minor, currency, vat_treatment, allowances, overage_per_enquiry_minor, effective_from, approval_decision_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (region, plan_key, plan_version) DO NOTHING`,
      [v.region, p.plan_key, p.plan_version, p.name, p.price_minor, p.currency, p.vat_treatment, JSON.stringify(p.allowances), p.overage_per_enquiry_minor, p.effective_from, decisionId]);
  }
  console.log(`Approved and written: ${summary}`);
} finally {
  await owner.end();
  await h.close();
}
