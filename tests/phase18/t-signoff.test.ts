import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runBootChecks, type BootDeps } from '@sevari/boot';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms } from '@sevari/crypto';
import { connect, type DbHandle } from '@sevari/db';
import { authenticate, newOperatorToken, platformDecision } from '@sevari/identity';
import { contractSuite } from '../support/contract.ts';
import { isolatedDatabase } from '../support/db.ts';
import { fixtures } from '../support/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));

contractSuite('T-SIGNOFF', () => {
  let iso: Awaited<ReturnType<typeof isolatedDatabase>>;
  let app: DbHandle;
  let deps: BootDeps;
  const ops: Record<string, string> = {};

  beforeAll(async () => {
    iso = await isolatedDatabase();
    app = connect(iso.appUrl);
    const f = fixtures(iso);
    for (const role of ['founder', 'counsel', 'operator'] as const) {
      const t = newOperatorToken();
      await f.ownerQuery('INSERT INTO operators (display_name, prefix, token_hash, role) VALUES ($1, $2, $3, $4)', [`Test ${role}`, t.prefix, t.hash, role]);
      ops[role] = t.full;
    }
    // A configuration that CLAIMS counsel signed off live tenants for the UK cell.
    const dir = await mkdtemp(join(tmpdir(), 'sevari-cfg-'));
    await cp(join(ROOT, 'config'), dir, { recursive: true });
    const uk = (await readFile(join(dir, 'regions', 'uk.yaml'), 'utf8'))
      .replace('counsel_signoff: null', 'counsel_signoff: { signed_by: "Example Counsel LLP", signed_on: "2026-10-01", scope: [live_tenants], reference: "CS-1" }')
      .replace('signoff_expires_on: null', 'signoff_expires_on: "2027-10-01"');
    await writeFile(join(dir, 'regions', 'uk.yaml'), uk);
    deps = { db: app.db, kms: LocalKeyFileKms.fromKey(Buffer.alloc(32, 7)), region: 'uk', configDir: dir, egressPolicyPath: join(dir, 'egress.allowlist.yaml'), clock };
  });
  afterAll(async () => {
    await app.close();
    await iso.drop();
  });

  const signoffCheck = async () => (await runBootChecks(deps)).checks.find((c) => c.name === 'signoffs');
  const sign = async (role: string, expiresOn: string) => {
    const cred = await authenticate(app.db, clock, ops[role]);
    return platformDecision(app.db, cred!, { decision: 'signoff', subjectRef: 'region:uk', reason: 'UK live tenants approved (CS-1)', scope: 'region:uk:live_tenants', expiresOn });
  };

  it('a sign-off in configuration alone does not pass the boot check', async () => {
    expect(await signoffCheck()).toMatchObject({ ok: false, detail: expect.stringMatching(/no current sign-off record by counsel and founder/) });
  });

  it('counsel alone is not enough: legal sign-offs need two people (§30.5)', async () => {
    await sign('counsel', '2027-10-01');
    expect(await signoffCheck()).toMatchObject({ ok: false, detail: expect.stringMatching(/by founder/) });
  });

  it('an ordinary operator can\'t sign off', async () => {
    await expect(sign('operator', '2027-10-01')).rejects.toThrow(/§71/);
  });

  it('counsel and the founder, unexpired: the boot check passes', async () => {
    await sign('founder', '2027-10-01');
    expect(await signoffCheck()).toMatchObject({ ok: true });
  });

  it('an expired record no longer counts', async () => {
    const later: BootDeps = { ...deps, clock: new FixedClock(Date.parse('2027-11-01T09:00:00Z')) };
    const c = (await runBootChecks(later)).checks.find((x) => x.name === 'signoffs');
    expect(c?.ok).toBe(false);
  });
});
