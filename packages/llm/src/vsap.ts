/** VSAP gateway provider (§9): interface defined, implementation deferred. */
import { NotImplementedError } from '@sevari/domain';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.ts';

export class VsapGatewayProvider implements LlmProvider {
  readonly id = 'vsap';
  readonly modelId = 'vsap:unconfigured';
  readonly egressHosts: readonly string[] = [];
  async generate(_req: LlmRequest): Promise<LlmResponse> {
    throw new NotImplementedError('VSAP gateway provider (contract §9)');
  }
  async healthy(): Promise<boolean> {
    return false;
  }
}
