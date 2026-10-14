/** Vertical pack shape (§9, §42): data, not code. Packs live in @sevari/verticals. */
export interface PhraseRule {
  readonly p: string;
  readonly w: number;
}

export interface IntentRule {
  readonly intent: Intent;
  readonly phrases: readonly PhraseRule[];
}

export const INTENTS = [
  'emergency', 'quote_request', 'booking_request', 'availability_question', 'price_question', 'service_question',
  'reschedule', 'cancel', 'complaint', 'data_rights', 'opt_out', 'follow_up', 'thanks', 'other',
] as const;
export type Intent = (typeof INTENTS)[number];

export interface PackService {
  readonly code: string;
  readonly name: string;
  readonly keywords: readonly string[];
  readonly emergency: boolean;
}

export interface VerticalPack {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** §9: regulated trades can't be activated without a recorded human approval. */
  readonly regulated: boolean;
  /** §42: emergency trades carry safety-first handling. */
  readonly emergencyTrade: boolean;
  readonly services: readonly PackService[];
  readonly intentRules: readonly IntentRule[];
  /** One targeted question per missing slot or ambiguity (§30.4 clarification loop). */
  readonly clarifyingQuestions: Readonly<Record<string, string>>;
  /** Deterministic safety-first message for risk to life (§42). Never model-worded. */
  readonly safetyMessage?: string;
}
