/**
 * Channel adapter interface (contract §9). An adapter turns a raw, authenticated provider request into
 * typed inbound items, and later sends. Adapters declare their egress hosts (checked against the
 * allowlist, F2) and their consent model. They never touch the database: intake does.
 */
export type ChannelId = 'webform' | 'email' | 'sms' | 'api' | 'telephony';

export interface RawInbound {
  readonly body: Buffer;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The public URL the provider called (some providers sign it). */
  readonly url: string;
}

export interface InboundItem {
  /** Provider's id for this message: the idempotency key (T-IDEM, F42). */
  readonly providerMessageId: string;
  readonly kind: 'enquiry' | 'task';
  readonly from: { readonly email?: string; readonly phone?: string; readonly name?: string };
  readonly subject?: string;
  readonly text: string;
}

export type VerifyResult =
  | { readonly ok: true; readonly drop?: undefined }
  /** Authentic transport but must be discarded silently (e.g. a bot filled the honeypot). */
  | { readonly ok: true; readonly drop: string }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 413; readonly reason: string };

export interface VerifyContext {
  readonly secret: Buffer | null;
  readonly allowedOrigins: readonly string[];
  readonly nowMs: number;
}

export interface ChannelAdapter {
  readonly channel: ChannelId;
  readonly capabilities: { readonly inbound: boolean; readonly outbound: boolean; readonly maxBodyBytes: number };
  /** How a person's permission to be contacted on this channel arises (§17). */
  readonly consentModel: 'reply_to_own_contact' | 'opt_in' | 'n/a';
  /** Hosts this adapter calls when sending. Must all be on the cell allowlist before use. */
  readonly egressHosts: readonly string[];
  verify(raw: RawInbound, ctx: VerifyContext): VerifyResult;
  /** Throws InboundParseError on malformed input. */
  parse(raw: RawInbound): InboundItem;
}

export class InboundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundParseError';
  }
}

/** Removes NUL and other C0 controls except tab/newline, normalises Unicode, trims, caps length. */
export function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}
