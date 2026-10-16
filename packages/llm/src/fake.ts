/**
 * Deterministic stand-in model for tests, CI and development (no model server here). It can be told
 * to behave badly (invent prices, follow injected instructions, break the schema) so tests prove the
 * deterministic layers catch it.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.ts';

export type FakeBehaviour = (req: LlmRequest) => string;

export class FakeLlmProvider implements LlmProvider {
  readonly id = 'fake';
  readonly modelId: string;
  readonly egressHosts: readonly string[] = [];
  readonly calls: LlmRequest[] = [];
  behaviour: FakeBehaviour;
  up = true;
  constructor(modelId = 'fake:deterministic-1', behaviour: FakeBehaviour = () => '{}') {
    this.modelId = modelId;
    this.behaviour = behaviour;
  }
  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    if (!this.up) throw new Error('fake model down');
    const raw = this.behaviour(req);
    return { modelId: this.modelId, raw, promptTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(raw.length / 4), latencyMs: 1 };
  }
  async healthy(): Promise<boolean> {
    return this.up;
  }
}
