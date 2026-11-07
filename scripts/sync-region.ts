/**
 * Writes a region's contact rules (§17.3) from config/regions/<code>.yaml into the cell database, as the
 * owner role. The boot check "region.rules" refuses a cell whose copy differs.
 *
 *   SEVARI_OWNER_DATABASE_URL=... node scripts/sync-region.ts --region uk [--config config]
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { contactRulesFromConfig, loadRegionConfig, taxRulesFromConfig } from '@sevari/region';

const { values: v } = parseArgs({ options: { region: { type: 'string', default: 'uk' }, config: { type: 'string', default: 'config' } } });
const url = process.env['SEVARI_OWNER_DATABASE_URL'];
if (!url) throw new Error('set SEVARI_OWNER_DATABASE_URL (the owner role)');
const cfg = await loadRegionConfig(v.config, v.region);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const r = await client.query('UPDATE regions SET contact_rules = $2::jsonb, tax_rules = $3::jsonb WHERE code = $1', [cfg.code, JSON.stringify(contactRulesFromConfig(cfg)), JSON.stringify(taxRulesFromConfig(cfg))]);
  if (r.rowCount !== 1) throw new Error(`region ${cfg.code} is not registered in this database`);
  console.log(`contact and tax rules for ${cfg.code} written from config`);
} finally {
  await client.end();
}
