/**
 * LLM provider interface (contract §9, §5.3). The model gets a facts bundle and a style, never database
 * access or tools (§36.3). Output is schema-constrained; anything that doesn't validate is an abstain.
 */
export type LlmTask = 'classify_intent' | 'word_reply';

export interface LlmRequest {
  readonly task: LlmTask;
  /** Versioned prompt id, recorded in lineage (§32 T-REPLAY). */
  readonly promptId: string;
  readonly system: string;
  /** The user turn. Customer text inside it is delimited and labelled as data (§36.3). */
  readonly user: string;
  /** JSON schema the output must satisfy (constrained decoding where the server supports it). */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly temperature?: number;
  readonly seed?: number;
}

export interface LlmResponse {
  readonly modelId: string;
  readonly raw: string;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly modelId: string;
  /** Hosts this provider calls; must be allowlisted for the cell (INV-3). */
  readonly egressHosts: readonly string[];
  generate(req: LlmRequest): Promise<LlmResponse>;
  healthy(): Promise<boolean>;
}

export class LlmUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailable';
  }
}
