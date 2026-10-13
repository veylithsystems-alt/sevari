import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { connect, withTenant, type DbHandle } from '@sevari/db';
import { regionCode, tenantId, type TenantScope } from '@sevari/domain';
import { dbInfo } from './db.ts';

export interface Urls { readonly superUrl: string; readonly ownerUrl: string; readonly appUrl: string }

async function run(url: string, sqlText: string, params: unknown[]): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sqlText, params);
  } finally {
    await c.end();
  }
}

export function fixtures(urls: Urls = dbInfo()) {
  const ownerQuery = (s: string, p: unknown[] = []) => run(urls.ownerUrl, s, p);
  const superQuery = (s: string, p: unknown[] = []) => run(urls.superUrl, s, p);
  const ensureRegion = async (code: string, name = code.toUpperCase()) =>
    void (await ownerQuery('INSERT INTO regions (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [code, name]));
  const appDb = (): DbHandle => connect(urls.appUrl);
  /** Creates a tenant the way the provisioning job does: as the app role, inside the new tenant's own scope. */
  const newTenant = async (h: DbHandle, region = 'uk', name = 'Test Trades Ltd'): Promise<TenantScope> => {
    await ensureRegion(region);
    const scope: TenantScope = { tenantId: tenantId(randomUUID()), region: regionCode(region) };
    await withTenant(h.db, scope, (tx) => tx.insertInto('tenants').values({ id: scope.tenantId, region: scope.region, display_name: name }).execute());
    return scope;
  };
  return { ownerQuery, superQuery, ensureRegion, appDb, newTenant };
}

// Shared-database shortcuts (lazy: dbInfo() is only valid inside a running test file).
export const ownerQuery = (s: string, p: unknown[] = []) => fixtures().ownerQuery(s, p);
export const superQuery = (s: string, p: unknown[] = []) => fixtures().superQuery(s, p);
export const ensureRegion = (code: string, name?: string) => fixtures().ensureRegion(code, name);
export const appDb = () => fixtures().appDb();
export const newTenant = (h: DbHandle, region?: string, name?: string) => fixtures().newTenant(h, region, name);

export const PROVENANCE = { source: 'web_form', lawful_basis: 'legitimate_interests_enquiry_response', captured_at: '2026-10-13T09:00:00Z', captured_by: 'intake:webform' } as const;
