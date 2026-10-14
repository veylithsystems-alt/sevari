/**
 * Erasure registry (§6.4, INV-6). Every table and every personal-data column is declared here.
 * The build fails if a column tagged '@pii' in a migration has no entry (boot check + F5).
 * The DSAR export, the ROPA and the retention schedule are generated from this file.
 *
 * Retention values marked `status: 'H'` are hypotheses until counsel confirms (§27.7, §40.7).
 */
export type DataCategory = 'none' | 'contact' | 'special' | 'financial' | 'audit';
export type ErasureAction = 'delete' | 'anonymise' | 'crypto-shred' | 'retain-legal-hold' | 'none';

export interface Retention {
  readonly days: number | null;
  readonly trigger: 'created' | 'relationship_end' | 'tenant_exit' | 'never';
  readonly status: 'H' | 'counsel_confirmed';
}

export interface ColumnEntry {
  readonly category: DataCategory;
  readonly erasure: ErasureAction;
  /** Included in a DSAR export (F20: only registry-declared fields are exported). */
  readonly dsar: boolean;
  readonly note?: string;
}

export interface TableEntry {
  readonly purpose: string;
  readonly lawfulBasis: string;
  readonly category: DataCategory;
  readonly retention: Retention;
  /** What erasure of a data subject does to rows of this table. */
  readonly erasure: ErasureAction;
  readonly legalHoldReason?: string;
  readonly columns: Readonly<Record<string, ColumnEntry>>;
}

const H = (days: number | null, trigger: Retention['trigger']): Retention => ({ days, trigger, status: 'H' });
const enc = (dsar = true): ColumnEntry => ({ category: 'contact', erasure: 'delete', dsar });

export const ERASURE_REGISTRY: Readonly<Record<string, TableEntry>> = {
  regions: { purpose: 'cell configuration', lawfulBasis: 'n/a (no personal data)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  schema_migrations: { purpose: 'migration ledger', lawfulBasis: 'n/a (no personal data)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  tenants: {
    purpose: 'tenant account', lawfulBasis: 'contract (Veylith as controller for tenant data)', category: 'contact',
    retention: H(2190, 'tenant_exit'), erasure: 'anonymise',
    columns: { display_name: { category: 'contact', erasure: 'anonymise', dsar: true, note: 'a sole trader name is personal data' } },
  },
  region_transfer_contracts: { purpose: 'INV-2 transfer records', lawfulBasis: 'legal obligation (accountability)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  tenant_keys: { purpose: 'envelope keys', lawfulBasis: 'security of processing', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'crypto-shred', columns: {} },
  audit_events: {
    purpose: 'tamper-evident record of decisions', lawfulBasis: 'legitimate interests / legal obligation (accountability)', category: 'audit',
    retention: H(2190, 'created'), erasure: 'retain-legal-hold',
    legalHoldReason: 'Audit rows hold ids and digests only, no personal data; their content targets are crypto-shredded.', columns: {},
  },
  audit_checkpoints: { purpose: 'audit anchoring', lawfulBasis: 'legitimate interests (integrity)', category: 'audit', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'hashes only', columns: {} },
  users: {
    purpose: 'tenant staff accounts', lawfulBasis: 'contract', category: 'contact', retention: H(365, 'relationship_end'), erasure: 'delete',
    columns: { display_name_enc: enc(), email_enc: enc(), email_bidx: enc(false), phone_enc: enc(), phone_bidx: enc(false) },
  },
  contacts: {
    purpose: 'people the tenant deals with', lawfulBasis: 'per contact: recorded in lawful_basis column', category: 'contact',
    retention: H(730, 'relationship_end'), erasure: 'delete',
    columns: {
      display_name_enc: enc(), email_enc: enc(), email_bidx: enc(false), phone_enc: enc(), phone_bidx: enc(false),
      vulnerable_flag: { category: 'special', erasure: 'delete', dsar: true, note: 'set by a human only; never inferred' },
    },
  },
  conversations: { purpose: 'threading', lawfulBasis: 'as the contact', category: 'contact', retention: H(730, 'relationship_end'), erasure: 'delete', columns: {} },
  messages: {
    purpose: 'enquiry content', lawfulBasis: 'as the contact', category: 'contact', retention: H(730, 'relationship_end'), erasure: 'delete',
    columns: {
      body_enc: enc(), body_digest: { category: 'contact', erasure: 'delete', dsar: false },
      subject_enc: enc(), raw_enc: { category: 'contact', erasure: 'delete', dsar: true, note: 'raw inbound payload as received (§5.2)' },
    },
  },
  channel_endpoints: { purpose: 'routing inbound channels to a tenant', lawfulBasis: 'contract', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'delete', columns: {} },
  api_keys: { purpose: 'tenant API authentication', lawfulBasis: 'contract / security', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'delete', columns: {} },
  knowledge_records: { purpose: 'owner-confirmed business facts (I5)', lawfulBasis: 'contract', category: 'contact', retention: H(null, 'tenant_exit'), erasure: 'crypto-shred', columns: {} },
  enquiries: {
    purpose: 'deterministic analysis of each enquiry (§5.2, §10.2)', lawfulBasis: 'as the contact', category: 'contact', retention: H(730, 'relationship_end'), erasure: 'delete',
    columns: {
      analysis_enc: enc(),
      flags: { category: 'special', erasure: 'delete', dsar: true, note: 'routing signals for a human; never an inference about the person' },
    },
  },
  job_queue: { purpose: 'durable work queue (ids only)', lawfulBasis: 'as the underlying record', category: 'none', retention: H(30, 'created'), erasure: 'delete', columns: {} },
};

/** Columns tagged '@pii' in the schema but missing from the registry. Empty = INV-6 holds. */
export function registryGaps(
  piiColumns: ReadonlyArray<{ table: string; column: string }>,
  tables: readonly string[],
  registry: Readonly<Record<string, TableEntry>> = ERASURE_REGISTRY,
): string[] {
  const gaps: string[] = [];
  for (const t of tables) if (!registry[t]) gaps.push(`table ${t} has no erasure-registry entry`);
  for (const { table, column } of piiColumns) {
    if (!registry[table]?.columns[column]) gaps.push(`${table}.${column} is tagged @pii but has no registry entry`);
  }
  for (const [t, e] of Object.entries(registry)) {
    if (e.erasure === 'retain-legal-hold' && !e.legalHoldReason) gaps.push(`${t}: retain-legal-hold needs a reason`);
  }
  return gaps;
}
