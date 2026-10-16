/**
 * Deterministic JSON: object keys sorted, no whitespace, -0 normalised, undefined dropped.
 * Used for approval digests (§7.1), audit payloads and replay lineage, so the same logical
 * payload always produces the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v.normalize('NFC'));
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : serialise(x))).join(',')}]`;
      if (v instanceof Date) return JSON.stringify(v.toISOString());
      if (v instanceof Uint8Array) return JSON.stringify(`hex:${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}`);
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${serialise(x)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
  }
}
