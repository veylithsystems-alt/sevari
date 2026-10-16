/**
 * The only outbound HTTP client in the codebase (contract §4, INV-3). Lint forbids network modules
 * everywhere else. Rules:
 *  - HTTPS only, exact host + port on the cell's allowlist, checked before any socket opens.
 *  - Redirects are never followed automatically (a redirect target is a new, separately checked request).
 *  - Requests go through the cell's hostname-aware forward proxy when one is configured (§60.1),
 *    so the firewall can drop every other outbound packet.
 *  - Bounded: timeout, response size cap, no unbounded retries.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { ContractViolation } from '@sevari/domain';
import { isAllowed, type EgressPolicy } from './allowlist.ts';

export class EgressDenied extends ContractViolation {
  readonly host: string;
  constructor(host: string, port: number, why: string) {
    super('INV-3', `egress to ${host}:${port} denied: ${why}`);
    this.name = 'EgressDenied';
    this.host = host;
  }
}

export interface EgressRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** Low-level transport, injectable for tests. Called only after the policy allows the request. */
export type Transport = (req: EgressRequest & { host: string; port: number; path: string }, proxy?: URL) => Promise<EgressResponse>;

export interface EgressClientOptions {
  readonly policy: EgressPolicy;
  readonly region: string;
  /** e.g. http://127.0.0.1:3128 : the cell's egress proxy. Required in production (boot check). */
  readonly proxyUrl?: string;
  readonly transport?: Transport;
  /** Observability hook: every decision, allowed or denied. Never includes bodies. */
  readonly onDecision?: (d: { host: string; port: number; allowed: boolean; reason?: string }) => void;
}

export class EgressClient {
  readonly #opts: EgressClientOptions;
  constructor(opts: EgressClientOptions) {
    this.#opts = opts;
  }

  /** Throws EgressDenied without touching the network when the URL is not allowed. */
  check(rawUrl: string): { host: string; port: number; path: string } {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new EgressDenied('(invalid)', 0, 'unparseable URL');
    }
    const port = u.port ? Number(u.port) : 443;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const deny = (why: string): never => {
      this.#opts.onDecision?.({ host, port, allowed: false, reason: why });
      throw new EgressDenied(host, port, why);
    };
    if (u.protocol !== 'https:') deny('only https is allowed');
    if (u.username || u.password) deny('credentials in URL are not allowed');
    if (/^[\d.]+$/.test(host) || host.includes(':')) deny('IP literals are not allowed; use an allowlisted hostname');
    if (!isAllowed(this.#opts.policy, this.#opts.region, host, port)) deny('host is not on the cell allowlist');
    this.#opts.onDecision?.({ host, port, allowed: true });
    return { host, port, path: `${u.pathname}${u.search}` };
  }

  async send(req: EgressRequest): Promise<EgressResponse> {
    const target = this.check(req.url);
    const transport = this.#opts.transport ?? nodeTransport;
    return transport({ ...req, ...target }, this.#opts.proxyUrl ? new URL(this.#opts.proxyUrl) : undefined);
  }
}

/** Default transport: HTTPS, through the CONNECT proxy when configured. Redirects are returned, not followed. */
const nodeTransport: Transport = (req, proxy) =>
  new Promise((resolve, reject) => {
    const timeoutMs = req.timeoutMs ?? 15_000;
    const maxBytes = req.maxResponseBytes ?? 5 * 1024 * 1024;
    const issue = (socket?: Socket) => {
      const r = httpsRequest({
        host: req.host, port: req.port, path: req.path, method: req.method ?? 'GET', headers: req.headers,
        servername: req.host, timeout: timeoutMs, ...(socket ? { socket, agent: false } : {}),
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy(new Error(`response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      r.on('timeout', () => r.destroy(new Error(`egress timeout after ${timeoutMs}ms`)));
      r.on('error', reject);
      if (req.body) r.write(req.body);
      r.end();
    };
    if (!proxy) return issue();
    const connect = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 3128), method: 'CONNECT', path: `${req.host}:${req.port}`, timeout: timeoutMs });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new EgressDenied(req.host, req.port, `proxy refused (${res.statusCode})`));
        return;
      }
      issue(socket);
    });
    connect.on('timeout', () => connect.destroy(new Error('proxy CONNECT timeout')));
    connect.on('error', reject);
    connect.end();
  });
