/**
 * Hostname-aware forward proxy (contract §60.1). The VPS firewall allows outbound traffic only from
 * this process, so a request that bypasses the egress client still can't leave the cell.
 *
 * Only HTTP CONNECT to an allowlisted host:port is accepted; TLS stays end-to-end (the proxy never
 * sees content). The destination is resolved here and private/loopback addresses are refused unless
 * the allowlist entry's role is 'self' (in-cell infrastructure), which blocks DNS-rebinding tricks.
 */
import { createServer, type Server } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { hostsForCell, type EgressPolicy } from './allowlist.ts';

export type Resolver = (host: string) => Promise<string>;

export interface ProxyOptions {
  readonly policy: EgressPolicy;
  readonly region: string;
  readonly resolve?: Resolver;
  readonly onDecision?: (d: { host: string; port: number; allowed: boolean; reason?: string; address?: string }) => void;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 6) return addr === '::1' || /^f[cd]/i.test(addr) || /^fe80/i.test(addr) || addr === '::';
  return PRIVATE_V4.some((r) => r.test(addr));
}

export function createEgressProxy(opts: ProxyOptions): Server {
  const resolve = opts.resolve ?? (async (h: string) => (await dnsLookup(h)).address);
  const server = createServer((_req, res) => {
    // Plain HTTP proxying is never allowed: outbound traffic must be TLS via CONNECT.
    res.writeHead(405, { 'content-type': 'text/plain' }).end('CONNECT only\n');
  });
  server.on('connect', (req, clientSocket, head) => {
    const deny = (code: number, host: string, port: number, reason: string) => {
      opts.onDecision?.({ host, port, allowed: false, reason });
      clientSocket.end(`HTTP/1.1 ${code} Forbidden\r\n\r\n`);
    };
    const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(req.url ?? '');
    if (!m || !m[1]) return deny(400, req.url ?? '', 0, 'malformed CONNECT target');
    const host = m[1].toLowerCase();
    const port = Number(m[2]);
    const entry = hostsForCell(opts.policy, opts.region).find((e) => e.host === host && e.port === port);
    if (!entry) return deny(403, host, port, 'not on the cell allowlist');
    resolve(host).then((address) => {
      if (isPrivateAddress(address) && entry.role !== 'self') return deny(403, host, port, `resolves to private address ${address}`);
      const upstream = netConnect(port, address, () => {
        opts.onDecision?.({ host, port, allowed: true, address });
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      clientSocket.on('error', () => upstream.destroy());
    }, () => deny(502, host, port, 'DNS resolution failed'));
  });
  return server;
}
