/* eslint-disable sevari/no-network-outside-egress -- F2 exercises the egress proxy over loopback (127.0.0.1) only; no outbound traffic. */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { connect as netConnect, createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createEgressProxy, EgressClient, EgressDenied, EgressPolicySchema, isAllowed, loadEgressPolicy, type Transport } from '@sevari/egress';
import { contractSuite } from '../support/contract.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Reserved names that can never route to a real third party (RFC 2606 / 6761) plus loopback. */
const NON_ROUTABLE = /^(localhost|127\.0\.0\.1|\[::1\]|([a-z0-9-]+\.)*(example|test|invalid|localhost)|([a-z0-9-]+\.)*example\.(com|org|net))$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'test' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|js|mjs|yaml|yml|json)$/.test(p)) out.push(p);
  }
  return out;
}

const policy = EgressPolicySchema.parse({
  version: 1, default: 'deny',
  cells: { uk: { hosts: [
    { host: 'api.allowed.test', port: 443, processor: 'test-proc', purpose: 'test' },
    { host: 'inference.cell.test', port: 443, processor: 'self-infra', purpose: 'test', private_network: true },
  ] } },
});

contractSuite('F2', () => {
  it('static: every URL host in source and config is allowlisted for some cell, or non-routable', async () => {
    const real = await loadEgressPolicy(resolve(ROOT, 'config/egress.allowlist.yaml'));
    const allowed = new Set(Object.values(real.cells).flatMap((c) => c.hosts.map((h) => h.host)));
    const files = [...sourceFiles(join(ROOT, 'packages')), ...sourceFiles(join(ROOT, 'apps')), ...sourceFiles(join(ROOT, 'config'))]
      .filter((f) => !f.includes('/packages/egress/src/')); // the egress package only handles URLs passed to it
    const offenders: string[] = [];
    for (const f of files) {
      // The processor registry cites its evidence (terms, DPA, sub-processor list) by URL: citations, not call targets.
      const text = f.endsWith('config/processors.yaml')
        ? readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(?:url|list_url|terms_url):|source: \{ url:/.test(l)).join('\n')
        : readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.[\]:-]+)/gi)) {
        const host = m[1]!.toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
        if (!allowed.has(host) && !NON_ROUTABLE.test(host)) offenders.push(`${f.replace(ROOT + '/', '')}: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('static: the real allowlist is default-deny and every host is an exact name', async () => {
    const real = await loadEgressPolicy(resolve(ROOT, 'config/egress.allowlist.yaml'));
    expect(real.default).toBe('deny');
    for (const c of Object.values(real.cells)) for (const h of c.hosts) expect(h.host).not.toContain('*');
  });

  it('client: a non-allowlisted host is refused before any transport call', async () => {
    const calls: string[] = [];
    const transport: Transport = async (r) => { calls.push(r.host); return { status: 200, headers: {}, body: Buffer.alloc(0) }; };
    const client = new EgressClient({ policy, region: 'uk', transport });
    for (const url of [
      'https://evil.example.com/x', 'http://api.allowed.test/x', 'https://api.allowed.test:8443/x',
      'https://1.2.3.4/x', 'https://[::1]/x', 'https://user:pw@api.allowed.test/', 'ftp://api.allowed.test/', 'not a url',
      'https://api.allowed.test.evil.example.com/', 'https://API.ALLOWED.TEST.evil.test/',
    ]) {
      await expect(client.send({ url })).rejects.toBeInstanceOf(EgressDenied);
    }
    expect(calls).toEqual([]);
    await client.send({ url: 'https://API.Allowed.Test./v1?q=1' });
    expect(calls).toEqual(['api.allowed.test']);
  });

  it('client: a different cell does not inherit another cell\'s allowlist', () => {
    expect(isAllowed(policy, 'uk', 'api.allowed.test')).toBe(true);
    expect(() => isAllowed(policy, 'ie1', 'api.allowed.test')).toThrow(/no entry for cell/);
  });

  describe_proxy();

  it('runtime: the firewall drops direct connections that bypass the proxy (nftables, network namespaces)', (ctx) => {
    let isRoot = false;
    try { isRoot = process.getuid?.() === 0 && execFileSync('which', ['ip', 'nft', 'setpriv']).length > 0; } catch { isRoot = false; }
    if (!isRoot) return ctx.skip('needs root, ip, nft and setpriv (CI runs ops/nftables/verify-in-netns.sh with sudo)');
    const out = execFileSync('bash', [join(ROOT, 'ops/nftables/verify-in-netns.sh'), join(ROOT, 'ops/nftables/sevari-egress.nft'), '12345'], { encoding: 'utf8', timeout: 60_000 });
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ app_https: 'blocked', proxy_https: 'ok', proxy_smtp: 'blocked', loopback: 'ok' });
    expect(r.dropped_packets).toBeGreaterThan(0);
  });
});

function describe_proxy(): void {
  let echo: Server;
  let echoPort = 0;
  let proxy: ReturnType<typeof createEgressProxy>;
  let proxyPort = 0;
  const decisions: Array<{ host: string; allowed: boolean; reason?: string }> = [];

  beforeAll(async () => {
    echo = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    echoPort = (echo.address() as { port: number }).port;
    const p = EgressPolicySchema.parse({
      version: 1, default: 'deny',
      cells: { uk: { hosts: [
        { host: 'inference.cell.test', port: echoPort, processor: 'self-infra', purpose: 'test', private_network: true },
        { host: 'rebind.allowed.test', port: echoPort, processor: 'test-proc', purpose: 'test' },
      ] } },
    });
    proxy = createEgressProxy({ policy: p, region: 'uk', resolve: async () => '127.0.0.1', onDecision: (d) => decisions.push(d) });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => echo.close(r));
  });

  const connectVia = (target: string): Promise<{ status: string; echo?: string }> =>
    new Promise((resolveP, reject) => {
      const s = netConnect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n') && !buf.includes('ping')) {
          const status = buf.split(' ')[1]!;
          if (status !== '200') { s.destroy(); return resolveP({ status }); }
          s.write('ping');
        } else if (buf.includes('ping')) {
          s.destroy();
          resolveP({ status: '200', echo: 'ping' });
        }
      });
      s.on('error', reject);
    });

  it('proxy: refuses a host that is not on the cell allowlist', async () => {
    expect((await connectVia(`evil.example.com:${echoPort}`)).status).toBe('403');
  });

  it('proxy: tunnels to an allowlisted host', async () => {
    expect(await connectVia(`inference.cell.test:${echoPort}`)).toEqual({ status: '200', echo: 'ping' });
  });

  it('proxy: refuses an allowlisted public host that resolves to a private address (DNS rebinding)', async () => {
    expect((await connectVia(`rebind.allowed.test:${echoPort}`)).status).toBe('403');
    expect(decisions.some((d) => d.host === 'rebind.allowed.test' && !d.allowed && /private address/.test(d.reason ?? ''))).toBe(true);
  });

  it('proxy: refuses plain HTTP proxying', async () => {
    const res = await new Promise<string>((r) => {
      const s = netConnect(proxyPort, '127.0.0.1', () => s.write('GET http://inference.cell.test/ HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { r(d.toString()); s.destroy(); });
    });
    expect(res).toMatch(/^HTTP\/1\.1 405/);
  });
}
