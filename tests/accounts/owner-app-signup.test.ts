import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { requestSignup, sendAccountMail } from '@sevari/accounts';
import { withTenant } from '@sevari/db';
import { FakeProvider } from '@sevari/outbound';
import { superQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

/**
 * The owner app from sign-up to a connected website form, in a real browser at phone size (§81: set up in
 * about ten minutes with no setup call). Needs Playwright's Chromium: runs when PW_PATH points at a
 * Playwright install, e.g. PW_PATH=$(npm root -g).
 */
let house: Harness;
const BASE = 'http://127.0.0.1:4778';
const mail = new FakeProvider();

beforeAll(async () => {
  house = await harness('pwacc', 171);
  await superQuery('UPDATE tenants SET is_house = true WHERE id = $1', [house.t.tenantId]);
});
afterAll(async () => house?.close());

describe('[Accounts] owner app: sign up and set up', () => {
  it('serves the sign-up page with no web addresses that could load anything from elsewhere', async () => {
    const app = buildServer({ intake: house.intake, publicBaseUrl: BASE, limiter: new TokenBucketLimiter(house.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: house.h.db, keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers }, accounts: { region: 'pwacc' } });
    for (const path of ['/app', '/app/app.js']) {
      const r = await app.inject({ method: 'GET', url: path });
      expect(r.body).not.toMatch(/https?:\/\//i);
      expect(r.body).not.toMatch(/innerHTML|eval\(|new Function/);
    }
    const embed = await app.inject({ method: 'GET', url: '/embed/form.js' });
    expect(embed.statusCode).toBe(200);
    expect(embed.headers['content-type']).toMatch(/javascript/);
    expect(embed.body).not.toMatch(/https?:\/\/|document\.cookie|localStorage|sessionStorage/);
    await app.close();
  });

  it.skipIf(!process.env['PW_PATH'])('signs up from the emailed link, fills in the details, checks and confirms them, and gets a website form', async () => {
    await requestSignup({ db: house.h.db, keyring: house.keyring, clock: house.clock, publicBaseUrl: BASE, region: 'pwacc' }, { email: 'owner@drains.example', contactName: 'Pat Example', businessName: 'Pat\'s Drains (example)', termsVersion: 't1' });
    const pending = await withTenant(house.h.db, house.t, (tx) => tx.selectFrom('account_mail').select('id').where('state', '=', 'pending').execute());
    for (const m of pending) await sendAccountMail({ db: house.h.db, keyring: house.keyring, clock: house.clock, provider: mail }, house.t, m.id);
    const link = /(http:\/\/127\.0\.0\.1:4778\/app#signup=\S+)/.exec([...mail.accepted.values()].at(-1)?.env.text ?? '')?.[1];
    expect(link).toBeTruthy();

    const app = buildServer({
      intake: house.intake, publicBaseUrl: BASE, limiter: new TokenBucketLimiter(house.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true,
      owner: { db: house.h.db, keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers },
      accounts: { region: 'pwacc', signup: { termsVersion: 't1', termsUrl: `${BASE}/terms`, privacyUrl: `${BASE}/privacy` } },
    });
    await app.listen({ port: 4778, host: '127.0.0.1' });
    const pw = await import(process.env['PW_PATH'] + '/playwright/index.js');
    const browser = await pw.chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      page.on('console', (msg: { type(): string; text(): string }) => { if (msg.type() === 'error') errors.push(msg.text()); });
      const text = (sel: string) => page.evaluate((s: string) => (globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector(s)?.textContent ?? '', sel);

      await page.goto(link);
      await page.waitForSelector('#setup-form:not([hidden])', { timeout: 8000 }).catch((e: Error) => { throw new Error(`${e.message} | page errors: ${errors.join(' / ')}`); });
      expect(await text('#status')).toMatch(/Email confirmed/);
      expect(await page.evaluate(() => (globalThis as unknown as { location: { hash: string } }).location.hash)).toBe(''); // the single-use link is not kept in history
      expect(await page.inputValue('#b-name')).toBe('Pat\'s Drains (example)');
      await page.fill('#b-desc', 'Drain unblocking for homes in Ellesmere Port');
      await page.fill('#b-privacy', 'patsdrains.example/privacy');
      await page.fill('.service .s-name', 'Drain unblocking');
      await page.fill('.service .s-words', 'blocked drain, sink won\'t drain');
      await page.selectOption('.service .s-basis', 'fixed');
      await page.fill('.service .s-pounds', '85');
      await page.fill('#a-codes', 'CH65, CH66');
      await page.fill('#a-desc', 'Ellesmere Port');
      if (process.env['SHOT_DIR']) await page.screenshot({ path: process.env['SHOT_DIR'] + '/setup-details.png', fullPage: true });
      await page.click('#setup-form button[type=submit]');
      await page.waitForSelector('#review:not([hidden]) .record', { timeout: 8000 }).catch(async (e: Error) => { throw new Error(`${e.message} | status: ${await text('#status')} | page errors: ${errors.join(' / ')}`); });
      const records = await text('#records');
      expect(records).toMatch(/Drain unblocking/);
      expect(records).toMatch(/£85\.00 fixed price, no VAT/);
      expect(records).toMatch(/CH65, CH66/);
      if (process.env['SHOT_DIR']) await page.screenshot({ path: process.env['SHOT_DIR'] + '/setup-review.png', fullPage: true });
      await page.click('#confirm-records');
      await page.waitForSelector('#connect:not([hidden])');
      await page.fill('#c-site', 'patsdrains.example');
      await page.click('#channel-form button[type=submit]');
      await page.waitForSelector('#snippet-box:not([hidden])');
      const snippet = await page.inputValue('#snippet');
      expect(snippet).toMatch(/data-sevari-form=/);
      expect(snippet).toMatch(/\/embed\/form\.js/);
      await page.click('#test-channel');
      await page.waitForSelector('#test-code:not([hidden])');
      expect(await text('#test-code')).toMatch(/Fill in the new form on your website, the way a customer would, with SV-\d+/);
      if (process.env['SHOT_DIR']) await page.screenshot({ path: process.env['SHOT_DIR'] + '/setup-connect.png', fullPage: true });
      expect(await text('#channel-list')).toMatch(/Website form on https:\/\/patsdrains\.example: not tested yet/);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);
});
