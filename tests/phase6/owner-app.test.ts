import { describe, it, expect } from 'vitest';
import { withTenant } from '@sevari/db';
import { createUserToken } from '@sevari/identity';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { harness, draftFor } from '../support/hitl-harness.ts';

/**
 * The owner inbox (Phase 6). The served files and their security policy are always checked. The full
 * browser run (sign in, see the draft, tap "Send it", see "Sent") needs Playwright's Chromium: it runs
 * when PW_PATH points at a Playwright install, e.g. PW_PATH=$(npm root -g).
 */
describe('[Phase 6] owner inbox app', () => {
it('serves the app same-origin only, under a strict security policy', async () => {
  const x = await harness('pwstatic', 62);
  const app = buildServer({ intake: x.intake, publicBaseUrl: 'https://t.example', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers } });
  for (const path of ['/app', '/app/app.js', '/app/app.css', '/app/manifest.webmanifest', '/app/icon.svg']) {
    const r = await app.inject({ method: 'GET', url: path });
    expect(r.statusCode, path).toBe(200);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'; script-src 'self'/);
    // No third-party resources: the only absolute URL allowed is the SVG namespace identifier.
    expect(r.body.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//i);
  }
  const api = await app.inject({ method: 'GET', url: '/health/live' });
  expect(api.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  await app.close();
  await x.close();
});

it.skipIf(!process.env['PW_PATH'])('works end to end in a real browser at phone size', async () => {
  const x = await harness('pwapp', 61);
  const m = await x.send('How much to unblock a drain? CH65 2AB');
  const r = await x.process(m.messageId);
  const token = await withTenant(x.h.db, x.t, (tx) => createUserToken(tx, x.clock, x.owner));
  const app = buildServer({ intake: x.intake, publicBaseUrl: 'http://127.0.0.1:4777', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers } });
  await app.listen({ port: 4777, host: '127.0.0.1' });
  const pw = await import(process.env['PW_PATH'] + '/playwright/index.js');
  const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => pw.chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (msg: { type(): string; text(): string }) => { if (msg.type() === 'error') errors.push(msg.text()); });
  // Signed in already (the sign-in link flow has its own browser test below).
  await page.addInitScript((t: string) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem('sevari.session', t), token);
  await page.goto('http://127.0.0.1:4777/app');
  await page.waitForSelector('.question', { timeout: 8000 }).catch((e: Error) => { throw new Error(`${e.message} | page errors: ${errors.join(' / ')}`); });
  if (process.env['SHOT_DIR']) await page.screenshot({ path: process.env['SHOT_DIR'] + '/owner-inbox.png', fullPage: true });
  x.clock.advance(10_000);
  await page.click('.question .q-actions button:first-child');
  await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#status')?.textContent?.includes('Approved'));
  await x.drain();
  await page.click('[data-go="inbox"]');
  await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#notes')?.textContent?.includes('Sent to the customer'));
  if (process.env['SHOT_DIR']) await page.screenshot({ path: process.env['SHOT_DIR'] + '/owner-inbox-after.png', fullPage: true });
  expect(errors).toEqual([]);
  expect((await draftFor(x, r.enquiryId))?.status).toBe('sent');
  await browser.close();
  await app.close();
  await x.close();
}, 60_000);
});
