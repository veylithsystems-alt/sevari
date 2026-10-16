/**
 * Model registry admin (§9). Runs as the owner role: SEVARI_OWNER_DATABASE_URL.
 *
 *   node scripts/model-registry.ts register eval/models/results/<file>.json
 *   node scripts/model-registry.ts promote  eval/models/results/<file>.json --by "Dan Hadfield"
 *   node scripts/model-registry.ts retire   --region uk --model <model id> --reason "<why>"
 *   node scripts/model-registry.ts list     --region uk
 *
 * promote refuses a fake run, a run that failed any gate, and a run older than 90 days (re-benchmark).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SystemClock } from '@sevari/clock';
import { listModels, promoteModel, registerModel, retireModel } from '@sevari/db';
import type { BenchResult } from '../eval/models/bench.ts';

const ownerUrl = process.env['SEVARI_OWNER_DATABASE_URL'];
if (!ownerUrl) throw new Error('set SEVARI_OWNER_DATABASE_URL (the owner role; never the app role)');
const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { by: { type: 'string' }, region: { type: 'string', default: 'uk' }, model: { type: 'string' }, reason: { type: 'string' } } });
const [cmd, file] = positionals;
const clock = new SystemClock();
const load = (f: string | undefined): BenchResult => {
  if (!f) throw new Error('give the bench result file');
  return JSON.parse(readFileSync(f, 'utf8')) as BenchResult;
};
const row = (r: BenchResult) => ({ ...r.entry, region: r.entry.region, benchRef: r.entry.benchRef });

if (cmd === 'register') {
  const r = load(file);
  if (r.fake) throw new Error('a fake bench run cannot be registered');
  await registerModel(ownerUrl, row(r));
  console.log(`registered ${r.entry.modelId} in ${r.entry.region} as candidate`);
} else if (cmd === 'promote') {
  const r = load(file);
  if (!v.by || v.by.trim().length < 3) throw new Error('--by "<your name>" is required: promotion is a human decision');
  if (r.fake) throw new Error('a fake bench run cannot be promoted');
  if (!r.gates.pass) throw new Error(`this run failed its gates: ${r.gates.reasons.join('; ')}`);
  const ageDays = (clock.nowMs() - Date.parse(r.date)) / 86_400_000;
  if (ageDays > 90) throw new Error(`bench run is ${Math.floor(ageDays)} days old; re-run the benchmark first`);
  await registerModel(ownerUrl, row(r));
  const ok = await promoteModel(ownerUrl, { region: r.entry.region, modelId: r.entry.modelId, approvedBy: v.by.trim(), at: clock.now() });
  console.log(ok ? `${r.entry.modelId} is active in ${r.entry.region}, approved by ${v.by.trim()}` : 'not promoted (not a candidate)');
} else if (cmd === 'retire') {
  if (!v.model || !v.reason) throw new Error('--model and --reason are required');
  console.log((await retireModel(ownerUrl, { region: v.region, modelId: v.model, reason: v.reason })) ? 'retired' : 'nothing to retire');
} else if (cmd === 'list') {
  console.table(await listModels(ownerUrl, v.region));
} else {
  throw new Error('usage: register | promote | retire | list (see the header of this file)');
}
