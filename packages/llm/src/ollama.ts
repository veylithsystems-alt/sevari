/**
 * Ollama provider (§9). Calls go through the egress client (the only network path, INV-3), to an
 * in-cell inference host that must be on the allowlist as private-network 'self' infrastructure.
 * The inference host is reached over TLS (a TLS terminator on the inference box; plain HTTP between
 * hosts is not allowed). Structured outputs: Ollama's `format` accepts a JSON schema.
 */
import type { Clock } from '@sevari/clock';
import type { EgressClient } from '@sevari/egress';
import { LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.ts';

export interface OllamaOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly egress: EgressClient;
  readonly clock: Clock;
  /** Keeps the model warm between calls (§9 warm keep-alive). */
  readonly keepAlive?: string;
  readonly numCtx?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly modelId: string;
  readonly egressHosts: readonly string[];
  readonly #o: OllamaOptions;
  constructor(o: OllamaOptions) {
    this.#o = o;
    this.modelId = `ollama:${o.model}`;
    this.egressHosts = [new URL(o.baseUrl).hostname];
  }
  async generate(req: LlmRequest): Promise<LlmResponse> {
    const started = this.#o.clock.nowMs();
    const res = await this.#o.egress.send({
      url: `${this.#o.baseUrl}/api/chat`, method: 'POST', timeoutMs: req.timeoutMs,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.#o.model, stream: false, keep_alive: this.#o.keepAlive ?? '30m', format: req.schema,
        options: { temperature: req.temperature ?? 0, seed: req.seed ?? 7, num_predict: req.maxTokens, num_ctx: this.#o.numCtx ?? 4096 },
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      }),
    });
    if (res.status !== 200) throw new LlmUnavailable(`ollama returned ${res.status}`);
    const j = JSON.parse(res.body.toString('utf8')) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return {
      modelId: this.modelId, raw: j.message?.content ?? '', promptTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0,
      latencyMs: this.#o.clock.nowMs() - started,
    };
  }
  async healthy(): Promise<boolean> {
    try {
      const r = await this.#o.egress.send({ url: `${this.#o.baseUrl}/api/tags`, timeoutMs: 2_000 });
      return r.status === 200;
    } catch {
      return false;
    }
  }
}
