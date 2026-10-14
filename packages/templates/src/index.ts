/**
 * Deterministic message templates (§5.3 templates by default, §42 safety-first, §50.3 rules).
 * Every value comes from tenant records. A missing value means no send and an owner task, never a gap.
 * Wording here is reviewed by humans; counsel reviews customer-facing wording before live use (§57.9).
 */
import { smsEncoding } from './sms.ts';

export type TemplateChannel = 'email' | 'sms' | 'webform' | 'api';
export type TemplateId = 'ack' | 'safety' | 'holding' | 'clarify';
export const TEMPLATE_VERSION = 'tpl-0.4.0';

export interface TemplateValues {
  readonly business: string;
  readonly replyTime: string;
  readonly privacyUrl: string;
  /** Shown when the tenant's policy or the law requires disclosure of automation (§8.4). Default on. */
  readonly discloseAutomation: boolean;
  readonly safetyMessage?: string;
  readonly question?: string;
}

export type RenderResult =
  | { readonly ok: true; readonly text: string; readonly templateId: TemplateId; readonly version: string; readonly sms?: ReturnType<typeof smsEncoding> }
  | { readonly ok: false; readonly reason: string };

/** SMS limit: 2 segments (§60.2). */
export const SMS_MAX_SEGMENTS = 2;
const MAX_BUSINESS_SMS = 40;

export function render(id: TemplateId, channel: TemplateChannel, v: TemplateValues): RenderResult {
  for (const [k, val] of Object.entries({ business: v.business, replyTime: v.replyTime, privacyUrl: v.privacyUrl })) {
    if (!val || !String(val).trim()) return { ok: false, reason: `missing value: ${k}` };
  }
  if (id === 'safety' && !v.safetyMessage) return { ok: false, reason: 'missing value: safetyMessage' };
  if (id === 'clarify' && !v.question) return { ok: false, reason: 'missing value: question' };
  const sms = channel === 'sms';
  if (sms && v.business.length > MAX_BUSINESS_SMS) return { ok: false, reason: `business name longer than ${MAX_BUSINESS_SMS} characters for SMS` };
  const auto = v.discloseAutomation ? (sms ? ' This is an automatic reply.' : ' This is an automatic reply.') : '';
  const optOut = sms ? ' Reply STOP to opt out.' : '';
  const privacy = sms ? ` Privacy: ${v.privacyUrl}` : `\n\nHow we use your information: ${v.privacyUrl}`;
  const greet = sms ? '' : 'Hello,\n\n';
  const sign = sms ? '' : `\n\n${v.business}`;

  let body: string;
  switch (id) {
    case 'ack':
      body = sms
        ? `${v.business}: thanks, we have your message and will reply ${v.replyTime}.${auto}`
        : `${greet}Thank you for contacting ${v.business}. We have received your message and will reply ${v.replyTime}.${auto}`;
      break;
    case 'holding':
      body = sms
        ? `${v.business}: thanks for your message. A member of the team will reply to you personally ${v.replyTime}.${auto}`
        : `${greet}Thank you for your message to ${v.business}. A member of the team will reply to you personally ${v.replyTime}.${auto}`;
      break;
    case 'safety':
      body = sms ? `${v.business}: ${v.safetyMessage}${auto}` : `${greet}${v.safetyMessage}${auto}`;
      break;
    case 'clarify':
      body = sms ? `${v.business}: ${v.question}${auto}` : `${greet}${v.question}${auto}`;
      break;
  }
  const text = `${body}${optOut}${privacy}${sign}`.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  if (sms) {
    const enc = smsEncoding(text);
    if (enc.encoding !== 'GSM-7') return { ok: false, reason: `non-GSM-7 characters: ${enc.nonGsm.join(' ')}` };
    if (enc.segments > SMS_MAX_SEGMENTS) return { ok: false, reason: `${enc.segments} segments exceeds the cap of ${SMS_MAX_SEGMENTS}` };
    return { ok: true, text, templateId: id, version: TEMPLATE_VERSION, sms: enc };
  }
  return { ok: true, text, templateId: id, version: TEMPLATE_VERSION };
}

export { smsEncoding, type SmsEncoding } from './sms.ts';
