/** SMS encoding and segment counting (§57.7, §60.2). Templates must stay in GSM-7. */
const GSM7_BASIC = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà']);
const GSM7_EXTENDED = new Set([...'^{}\\[~]|€\f']);

export interface SmsEncoding {
  readonly encoding: 'GSM-7' | 'UCS-2';
  readonly units: number;
  readonly segments: number;
  readonly nonGsm: readonly string[];
}

export function smsEncoding(text: string): SmsEncoding {
  const nonGsm = [...new Set([...text].filter((ch) => !GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)))];
  if (nonGsm.length) {
    const units = [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0);
    return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67), nonGsm };
  }
  const units = [...text].reduce((n, ch) => n + (GSM7_EXTENDED.has(ch) ? 2 : 1), 0);
  return { encoding: 'GSM-7', units, segments: units <= 160 ? 1 : Math.ceil(units / 153), nonGsm: [] };
}
