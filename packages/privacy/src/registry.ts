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
  model_registry: { purpose: 'model registry: which models a cell may use, with measured scores', lawfulBasis: 'n/a (no personal data)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  purpose_rules: { purpose: 'purpose limitation per source tier (§17.2)', lawfulBasis: 'n/a (no personal data)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  ledger_transactions: { purpose: 'double-entry ledger (§19.2)', lawfulBasis: 'legal obligation (tax and accounting records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory accounting records (HMRC: 6 years). No personal data: ids and amounts only.', columns: {} },
  ledger_entries: { purpose: 'ledger lines (§19.2)', lawfulBasis: 'legal obligation (tax and accounting records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory accounting records; the link to the person is removed on erasure.', columns: {} },
  invoice_counters: { purpose: 'gapless invoice numbering', lawfulBasis: 'legal obligation (VAT invoicing)', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'none', columns: {} },
  invoices: { purpose: 'invoices and credit notes (§19.2)', lawfulBasis: 'contract; legal obligation (tax records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory tax records (6 years); the link to the person is removed on erasure (§19.6).', columns: {} },
  invoice_lines: { purpose: 'invoice lines', lawfulBasis: 'legal obligation (tax records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory tax records; descriptions are service names only.', columns: {} },
  payment_links: { purpose: 'payment links from the business\'s own processor', lawfulBasis: 'contract', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Part of the payment record.', columns: {} },
  payment_events: { purpose: 'processor payment events (§19.2)', lawfulBasis: 'legal obligation (accounting records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory accounting records; ids and amounts only.', columns: {} },
  recon_lines: { purpose: 'reconciliation lines from processor reports and bank feeds (§19.3)', lawfulBasis: 'legal obligation (accounting records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory accounting records.', columns: { payer_hint: { category: 'financial', erasure: 'retain-legal-hold', dsar: true, note: 'payer name as printed on a statement; statutory record' } } },
  recon_matches: { purpose: 'reconciliation decisions with their rule and evidence (§19.3)', lawfulBasis: 'legal obligation (accounting records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Statutory accounting records.', columns: {} },
  plans: { purpose: 'versioned plans and prices (§47)', lawfulBasis: 'n/a (no personal data)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  subscriptions: { purpose: 'Veylith\'s subscriptions with the businesses it bills (§19.4)', lawfulBasis: 'contract', category: 'financial', retention: H(2190, 'relationship_end'), erasure: 'retain-legal-hold', legalHoldReason: 'Billing records (tax rules: 6 years after the relationship).', columns: {} },
  billing_runs: { purpose: 'usage counts per billing period (§19.4)', lawfulBasis: 'contract; legal obligation (tax records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Counts only; billing evidence.', columns: {} },
  accounting_connections: { purpose: 'each business\'s connection to its accounting software (§19.5)', lawfulBasis: 'contract', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'crypto-shred', columns: { token_enc: { category: 'none', erasure: 'crypto-shred', dsar: false, note: 'access token; its own key is shredded on disconnect' } } },
  accounting_mappings: { purpose: 'account code mapping for accounting sync', lawfulBasis: 'contract', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'none', columns: {} },
  accounting_sync_log: { purpose: 'what was pushed to the business\'s books, and when (§19.5)', lawfulBasis: 'legal obligation (accounting records)', category: 'financial', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Ids and outcomes only.', columns: {} },
  complaint_cases: { purpose: 'complaint cases: clock, owner, remedy within policy, root cause (§20)', lawfulBasis: 'legal obligation; legitimate interests (handling complaints)', category: 'contact', retention: H(2190, 'created'), erasure: 'anonymise', columns: {} },
  partners: { purpose: 'who a business may hand a case to, and on what basis (§21.3)', lawfulBasis: 'legal obligation (accountability)', category: 'contact', retention: H(null, 'tenant_exit'), erasure: 'delete', columns: { name: { category: 'contact', erasure: 'delete', dsar: false, note: 'a sole-trader partner\'s name' } } },
  offloads: { purpose: 'handovers of a case to a third party, with basis and minimum data (§21.3)', lawfulBasis: 'as the case', category: 'contact', retention: H(2190, 'created'), erasure: 'delete', columns: { bundle_enc: enc() } },
  tenant_offboardings: { purpose: 'a business leaving: notice, export, grace, erasure certificate (§21.1)', lawfulBasis: 'legal obligation (accountability)', category: 'none', retention: H(null, 'never'), erasure: 'none', columns: {} },
  signup_requests: { purpose: 'self-serve sign-up: the details typed, kept until the email is confirmed (§81)', lawfulBasis: 'steps before a contract (Veylith as controller)', category: 'contact', retention: H(1, 'created'), erasure: 'delete', columns: { email_enc: enc(), email_bidx: enc(false), contact_name_enc: enc(), business_name_enc: enc() } },
  account_directory: { purpose: 'which business an email address can sign in to (R-13)', lawfulBasis: 'contract (Veylith as controller)', category: 'contact', retention: H(null, 'relationship_end'), erasure: 'delete', columns: { email_bidx: enc(false) } },
  login_links: { purpose: 'single-use sign-in links, 15 minutes (R-13)', lawfulBasis: 'contract (Veylith as controller)', category: 'none', retention: H(1, 'created'), erasure: 'delete', columns: {} },
  account_mail: { purpose: 'Veylith\'s account emails: sign-up, sign-in, brief notices; destroyed once handed to the provider', lawfulBasis: 'contract (Veylith as controller)', category: 'contact', retention: H(30, 'created'), erasure: 'delete', columns: { recipient_enc: enc(false), body_enc: { category: 'contact', erasure: 'delete', dsar: false, note: 'a sign-in link; destroyed once sent' } } },
  portal_tokens: { purpose: 'magic links to a customer\'s own page (§22)', lawfulBasis: 'contract', category: 'contact', retention: H(30, 'created'), erasure: 'delete', columns: { token_hash: { category: 'contact', erasure: 'delete', dsar: false, note: 'hash of a link' } } },
  tenant_activations: { purpose: 'go-live decisions and their checklists (§18, §81)', lawfulBasis: 'legitimate interests (accountability)', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'none', columns: {} },
  tenant_packs: { purpose: 'each business\'s drafted and confirmed pack (§83.2)', lawfulBasis: 'contract', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'none', columns: {} },
  data_imports: { purpose: 'record of each data import and its lawful basis (§18)', lawfulBasis: 'legal obligation (accountability)', category: 'none', retention: H(2190, 'created'), erasure: 'none', columns: {} },
  lead_sources: { purpose: 'register of where contacts come from (§17.1)', lawfulBasis: 'legal obligation (accountability)', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'none', columns: {} },
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
  user_permissions: { purpose: 'what each team member may approve (§82)', lawfulBasis: 'contract', category: 'none', retention: H(365, 'relationship_end'), erasure: 'delete', columns: {} },
  approval_routes: { purpose: 'owner escalation order (§82)', lawfulBasis: 'contract', category: 'none', retention: H(null, 'tenant_exit'), erasure: 'delete', columns: {} },
  user_tokens: { purpose: 'owner app sign-in', lawfulBasis: 'contract', category: 'none', retention: H(90, 'created'), erasure: 'delete', columns: {} },
  platform_decisions: { purpose: 'platform decisions (§82)', lawfulBasis: 'legitimate interests (accountability)', category: 'audit', retention: H(2190, 'created'), erasure: 'none', columns: {} },
  operators: { purpose: 'platform operator credentials', lawfulBasis: 'legitimate interests (running the platform)', category: 'contact', retention: H(365, 'relationship_end'), erasure: 'delete', columns: { display_name: { category: 'contact', erasure: 'delete', dsar: true } } },
  drafts: {
    purpose: 'replies awaiting approval or sent (§7.1)', lawfulBasis: 'legitimate interests (enquiry response)', category: 'contact', retention: H(730, 'created'), erasure: 'delete',
    columns: { recipient_enc: enc(), body_enc: enc(), sources_enc: enc(false), content_digest: enc(false) },
  },
  approvals: { purpose: 'evidence of human approval (§7.1, I8)', lawfulBasis: 'legitimate interests (accountability)', category: 'contact', retention: H(2190, 'created'), erasure: 'anonymise', columns: { content_digest: enc(false) } },
  autonomy_grants: { purpose: 'earned autonomy per action class (§7.2)', lawfulBasis: 'contract', category: 'none', retention: H(2190, 'created'), erasure: 'none', columns: {} },
  human_questions: { purpose: 'structured questions to humans (§30.3)', lawfulBasis: 'legitimate interests (enquiry response)', category: 'contact', retention: H(730, 'created'), erasure: 'delete', columns: { body_enc: enc(), content_digest: enc(false) } },
  human_inputs: { purpose: 'every human decision and its effect (§30.1)', lawfulBasis: 'legitimate interests (accountability)', category: 'contact', retention: H(2190, 'created'), erasure: 'anonymise', columns: { detail_enc: enc() } },
  effect_receipts: { purpose: 'proof a human input took effect (INV-13)', lawfulBasis: 'legitimate interests (accountability)', category: 'none', retention: H(2190, 'created'), erasure: 'none', columns: {} },
  human_notifications: { purpose: 'owner inbox: questions, acknowledgements, outcomes (§74)', lawfulBasis: 'contract', category: 'contact', retention: H(365, 'created'), erasure: 'delete', columns: { body_enc: enc() } },
  subject_keys: { purpose: 'one data key per person, so erasure is cryptographic (§6.3)', lawfulBasis: 'security of processing', category: 'none', retention: H(null, 'never'), erasure: 'crypto-shred', columns: {} },
  dsar_requests: { purpose: 'data-rights requests and their clocks (§21.2)', lawfulBasis: 'legal obligation (data-rights handling)', category: 'contact', retention: H(2190, 'created'), erasure: 'retain-legal-hold', legalHoldReason: 'Proof that a rights request was handled on time; the copy of the data is sealed with the person\'s own key and becomes unreadable when they are erased.', columns: { export_enc: { category: 'contact', erasure: 'crypto-shred', dsar: false, note: 'the export itself' } } },
  consents: { purpose: 'consent ledger per person, purpose and channel (§17.2)', lawfulBasis: 'legal obligation (proof of consent, PECR/UK GDPR)', category: 'contact', retention: H(2190, 'relationship_end'), erasure: 'delete', columns: {} },
  erasure_log: { purpose: 'proof of erasure, and re-applying it after a backup restore (F35)', lawfulBasis: 'legal obligation (accountability)', category: 'contact', retention: H(null, 'never'), erasure: 'retain-legal-hold', legalHoldReason: 'Holds only ids and keyed blind indexes, needed to re-apply the erasure if a backup is ever restored.', columns: { identifiers: { category: 'contact', erasure: 'retain-legal-hold', dsar: false, note: 'blind indexes only' } } },
  retention_runs: { purpose: 'retention reports and enforcement runs (§6.4)', lawfulBasis: 'legal obligation (storage limitation)', category: 'none', retention: H(2190, 'created'), erasure: 'none', columns: {} },
  lifecycle_subjects: { purpose: 'where each customer is in their journey (§16)', lawfulBasis: 'contract / legitimate interests (running the service the customer asked for)', category: 'contact', retention: H(2190, 'relationship_end'), erasure: 'delete', columns: {} },
  lifecycle_transitions: { purpose: 'each step of a journey and the authority behind it (§16)', lawfulBasis: 'legitimate interests (accountability)', category: 'contact', retention: H(2190, 'relationship_end'), erasure: 'delete', columns: {} },
  lifecycle_timers: { purpose: 'scheduled journey steps (§16)', lawfulBasis: 'contract', category: 'none', retention: H(365, 'created'), erasure: 'delete', columns: {} },
  booking_offers: { purpose: 'appointment times offered to a customer', lawfulBasis: 'contract (steps at the customer\'s request)', category: 'contact', retention: H(365, 'created'), erasure: 'delete', columns: {} },
  bookings: { purpose: 'appointments (§16.1 stages 4 and 6)', lawfulBasis: 'contract', category: 'contact', retention: H(2190, 'relationship_end'), erasure: 'delete', columns: {} },
  owner_reports: { purpose: 'weekly owner reports (§8.1)', lawfulBasis: 'contract', category: 'contact', retention: H(730, 'created'), erasure: 'delete', columns: { body_enc: enc() } },
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
  knowledge_records: { purpose: 'owner-confirmed business facts (I5)', lawfulBasis: 'contract', category: 'contact', retention: H(null, 'tenant_exit'), erasure: 'crypto-shred', columns: { body_enc: { category: 'none', erasure: 'crypto-shred', dsar: false, note: 'the business\'s own facts; in its export, not in a person\'s copy' } } },
  enquiries: {
    purpose: 'deterministic analysis of each enquiry (§5.2, §10.2)', lawfulBasis: 'as the contact', category: 'contact', retention: H(730, 'relationship_end'), erasure: 'delete',
    columns: {
      analysis_enc: enc(),
      flags: { category: 'special', erasure: 'delete', dsar: true, note: 'routing signals for a human; never an inference about the person' },
    },
  },
  suppressions: {
    purpose: 'honour opt-outs immediately (§17.2)', lawfulBasis: 'legal obligation (PECR) / legitimate interests', category: 'contact',
    retention: H(null, 'never'), erasure: 'retain-legal-hold',
    legalHoldReason: 'A suppression must outlive erasure, or the person could be contacted again. Holds a keyed blind index only.',
    columns: { recipient_bidx: { category: 'contact', erasure: 'retain-legal-hold', dsar: false, note: 'blind index only' } },
  },
  outbox: {
    purpose: 'outbound messages and their delivery state', lawfulBasis: 'as the contact', category: 'contact', retention: H(730, 'relationship_end'), erasure: 'delete',
    columns: { recipient_enc: enc(), recipient_bidx: enc(false), body_enc: enc(), body_digest: { category: 'contact', erasure: 'delete', dsar: false } },
  },
  reply_records: { purpose: 'metrics and evidence (§10.2), codes only', lawfulBasis: 'legitimate interests (quality, accountability)', category: 'none', retention: H(1095, 'created'), erasure: 'none', columns: {} },
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

/**
 * What a business's own data export contains (§21.1, F20): per table, plain columns, and sealed columns that
 * are opened for the export. Every sealed column must be declared in the registry above, and nothing outside
 * this list is ever exported.
 */
export const TENANT_EXPORT: Readonly<Record<string, { readonly plain: readonly string[]; readonly sealed?: readonly string[] }>> = {
  contacts: { plain: ['id', 'source', 'lawful_basis', 'captured_at', 'subscriber_type'], sealed: ['display_name_enc', 'email_enc', 'phone_enc'] },
  messages: { plain: ['id', 'conversation_id', 'direction', 'channel', 'received_at'], sealed: ['subject_enc', 'body_enc'] },
  enquiries: { plain: ['id', 'message_id', 'intent', 'route', 'services', 'analysed_at'] },
  bookings: { plain: ['id', 'contact_id', 'service', 'starts_at', 'ends_at', 'status'] },
  invoices: { plain: ['id', 'number', 'contact_id', 'kind', 'status', 'currency', 'net_minor', 'vat_minor', 'total_minor', 'paid_minor', 'issued_at', 'due_on'] },
  invoice_lines: { plain: ['invoice_id', 'position', 'description', 'quantity', 'unit_minor', 'amount_minor'] },
  payment_events: { plain: ['invoice_id', 'kind', 'amount_minor', 'fee_minor', 'currency', 'occurred_at'] },
  consents: { plain: ['contact_id', 'purpose', 'channel', 'action', 'basis', 'source', 'wording_version', 'recorded_at'] },
  knowledge_records: { plain: ['id', 'record_key', 'kind', 'record_version', 'status', 'confirmed_at'], sealed: ['body_enc'] },
  complaint_cases: { plain: ['id', 'contact_id', 'category', 'status', 'opened_at', 'respond_by', 'resolved_at', 'root_cause'] },
  lead_sources: { plain: ['key', 'tier', 'type', 'lawful_basis', 'acquired_from'] },
  data_imports: { plain: ['kind', 'lawful_basis', 'acquired_from', 'rows_imported', 'imported_at'] },
};

/** F20: every exported sealed column is declared; every exported table is in the registry. */
export function tenantExportIsDeclared(): string[] {
  const problems: string[] = [];
  for (const [table, spec] of Object.entries(TENANT_EXPORT)) {
    const entry = ERASURE_REGISTRY[table];
    if (!entry) { problems.push(`${table} is exported but not in the registry`); continue; }
    for (const c of spec.sealed ?? []) if (!entry.columns[c]) problems.push(`${table}.${c} is exported but not declared`);
  }
  return problems;
}
