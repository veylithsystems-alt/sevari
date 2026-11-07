import type { ColumnType, Generated, Selectable } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, never>;
type Meta = { created_at: Ts; updated_at: Ts; version: ColumnType<number, never, never> };

export interface RegionsTable extends Meta {
  code: string;
  name: string;
  counsel_signoff: unknown | null;
  signoff_expires_on: Date | null;
  contact_rules: ColumnType<Record<string, unknown>, string | undefined, string>;
  tax_rules: ColumnType<Record<string, unknown>, string | undefined, string>;
}
export interface TenantsTable extends Meta {
  id: Generated<string>;
  tenant_id: ColumnType<string, never, never>;
  region: string;
  display_name: string;
  status: Generated<'prospect' | 'onboarding' | 'shadow' | 'active' | 'suspended' | 'offboarding' | 'closed'>;
  is_house: Generated<boolean>;
  holding_update_enabled: Generated<boolean>;
  reply_due_minutes: Generated<number>;
  regulated: Generated<boolean>;
  regulated_reasons: Generated<string[]>;
  activated_at: Date | null;
  money_mode: Generated<'direct' | 'platform_signed_off'>;
  money_mode_signoff: string | null;
}
export interface TenantKeysTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  key_version: number;
  purpose: Generated<'data' | 'blind_index'>;
  kek_id: string;
  wrapped_dek: Buffer | null;
  state: Generated<'active' | 'retired' | 'shredded'>;
  shredded_at: Date | null;
}
export interface AuditEventsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  seq: ColumnType<string, never, never>;
  event_type: string;
  actor_kind: 'system' | 'user' | 'provider' | 'customer' | 'operator';
  actor_ref: string | null;
  subject_ref: string | null;
  payload: ColumnType<unknown, string, never>;
  prev_hash: ColumnType<Buffer, never, never>;
  hash: ColumnType<Buffer, never, never>;
}
export interface AuditCheckpointsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  seq: string;
  head_hash: Buffer;
  key_id: string;
  signature: Buffer;
}
export interface UsersTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  role: 'owner' | 'approver' | 'viewer';
  display_name_enc: Buffer;
  email_enc: Buffer | null;
  email_bidx: Buffer | null;
  phone_enc: Buffer | null;
  phone_bidx: Buffer | null;
  status: Generated<'invited' | 'active' | 'disabled'>;
}
export interface ContactsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  display_name_enc: Buffer | null;
  email_enc: Buffer | null;
  email_bidx: Buffer | null;
  phone_enc: Buffer | null;
  phone_bidx: Buffer | null;
  subscriber_type: Generated<'unknown' | 'individual' | 'sole_trader' | 'partnership' | 'company' | 'public_body'>;
  source: string;
  lawful_basis: string;
  captured_at: Date | string;
  captured_by: string;
  vulnerable_flag: Generated<boolean>;
}
export interface ConversationsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  contact_id: string;
  status: Generated<'open' | 'waiting_customer' | 'waiting_owner' | 'closed'>;
}
export interface MessagesTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  provider_message_id: string;
  body_enc: Buffer;
  body_digest: Buffer;
  received_at: Date | string;
  kind: Generated<'enquiry' | 'task'>;
  subject_enc: Buffer | null;
  raw_enc: Buffer | null;
  endpoint_id: string | null;
}
export interface ChannelEndpointsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  channel: 'webform' | 'email' | 'sms' | 'api' | 'telephony';
  public_id: string;
  secret_enc: Buffer | null;
  lawful_basis: string;
  purpose: string;
  allowed_origins: Generated<string[]>;
  status: Generated<'active' | 'disabled'>;
  check_code_hash: Buffer | null;
  verified_at: Date | null;
}
export interface ApiKeysTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  prefix: string;
  key_hash: Buffer;
  scopes: string[];
  status: Generated<'active' | 'revoked'>;
  expires_at: Date | null;
  last_used_at: Date | null;
}
export interface JobQueueTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  kind: string;
  dedupe_key: string;
  payload: ColumnType<unknown, string | undefined, string>;
  state: Generated<'queued' | 'running' | 'done' | 'failed' | 'dead'>;
  run_at: ColumnType<Date, Date | string | undefined, Date | string>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
}

export interface KnowledgeRecordsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  record_key: string;
  kind: 'service' | 'price' | 'hours' | 'area' | 'policy' | 'faq' | 'business' | 'resolution_policy';
  record_version: number;
  body_enc: Buffer;
  status: Generated<'draft' | 'confirmed' | 'retired' | 'rejected'>;
  source: 'onboarding_interview' | 'owner_edit' | 'import' | 'register_prefill' | 'system_default';
  proposed_by: string;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  effective_from: Date | null;
  effective_to: Date | null;
}
export interface EnquiriesTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  message_id: string;
  conversation_id: string;
  pack_id: string;
  pack_version: string;
  core_version: string;
  intent: string;
  intent_confidence: ColumnType<string, number, never>;
  intent_source: 'rules' | 'model';
  abstained: boolean;
  route: 'safety_first' | 'human_only' | 'opt_out' | 'clarify' | 'unknown' | 'answer';
  services: string[];
  flags: string[];
  urgency: string;
  eligibility: 'yes' | 'no' | 'unknown';
  facts_used: string[];
  facts_missing: string[];
  analysis_enc: Buffer;
  analysed_at: Date;
  intent_model_id: ColumnType<string | null, string | null | undefined, never>;
  intent_prompt_id: ColumnType<string | null, string | null | undefined, never>;
}

export interface ModelRegistryTable extends Meta {
  id: Generated<string>;
  region: string;
  model_id: string;
  provider: 'ollama' | 'vllm' | 'vsap' | 'fake';
  family: string;
  params_b: ColumnType<string, number, number>;
  quantisation: string;
  host: string;
  ctx_tokens: number;
  licence: string;
  tokens_per_s: ColumnType<string | null, number | null | undefined, number | null>;
  p95_latency_ms: ColumnType<Record<string, number>, string | undefined, string>;
  eval_scores: ColumnType<Record<string, Record<string, number>>, string | undefined, string>;
  bench_ref: string | null;
  cost_per_1k_minor: ColumnType<string, number | undefined, number>;
  status: Generated<'candidate' | 'active' | 'retired'>;
  promoted_by: string | null;
  promoted_at: Date | null;
  retired_reason: string | null;
}

export interface SuppressionsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  channel_scope: 'sms' | 'email' | 'all';
  recipient_bidx: Buffer;
  reason: 'stop_keyword' | 'opt_out_request' | 'provider_block' | 'owner' | 'complaint';
  source_ref: string | null;
}
export type OutboxState = 'reserved' | 'sending' | 'sent' | 'ambiguous' | 'failed' | 'blocked';
export interface OutboxTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  conversation_id: string;
  contact_id: string;
  in_reply_to: string | null;
  channel: 'email' | 'sms' | 'webform' | 'api';
  purpose: 'ack' | 'safety' | 'holding' | 'clarify' | 'reply' | 'marketing';
  action_class: string;
  dedupe_key: string;
  recipient_enc: Buffer;
  recipient_bidx: Buffer;
  body_enc: Buffer;
  body_digest: Buffer;
  template_id: string | null;
  template_version: string | null;
  state: Generated<OutboxState>;
  attempts: Generated<number>;
  lease_until: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  reserved_at: Date;
  initiative: Generated<'response' | 'proactive'>;
  not_before: Date | null;
  dispatched_at: Date | null;
  sent_at: Date | null;
}
export interface ReplyRecordsTable extends Meta {
  id: Generated<string>;
  tenant_id: string;
  region: string;
  inbound_message_id: string | null;
  enquiry_id: string | null;
  outbox_id: string | null;
  purpose: string;
  channel: string;
  intent: string | null;
  intent_confidence: ColumnType<string | null, number | null, never>;
  generator: 'template' | 'model' | 'human';
  template_id: string | null;
  model_id: string | null;
  tokens: number | null;
  facts_used: string[];
  facts_missing: string[];
  grounding_ok: boolean;
  grounding_failures: ColumnType<unknown, string, never>;
  autonomy_decision: string;
  approval_outcome: string | null;
  edit_size: number | null;
  edit_category: string | null;
  send_result: string;
  latency_ms: ColumnType<Record<string, number>, string, string>;
  cost_minor: number | null;
  prompt_id: ColumnType<string | null, string | null | undefined, never>;
}

type Tenant = { id: Generated<string>; tenant_id: string; region: string };

export interface UserPermissionsTable extends Meta, Tenant { user_id: string; action_class: string; granted_by: string; revoked_at: Date | null }
export interface ApprovalRoutesTable extends Meta, Tenant { position: number; user_id: string; after_minutes: number }
export interface UserTokensTable extends Meta, Tenant { user_id: string; prefix: string; token_hash: Buffer; status: Generated<'active' | 'revoked'>; expires_at: Date }
export type OperatorRole = 'founder' | 'operator' | 'counsel';
export interface PlatformDecisionsTable extends Meta { id: Generated<string>; operator_id: string; decision: string; subject_ref: string; reason: string; approver_role: OperatorRole; scope: string | null; expires_on: string | null }
export interface OperatorsTable extends Meta { id: Generated<string>; display_name: string; prefix: string; token_hash: Buffer; role: Generated<OperatorRole>; status: Generated<'active' | 'revoked'> }
export type DraftStatus = 'pending_approval' | 'approved' | 'rejected' | 'superseded' | 'expired' | 'sent' | 'failed' | 'blocked';
export interface DraftsTable extends Meta, Tenant {
  enquiry_id: string | null;
  conversation_id: string;
  contact_id: string;
  in_reply_to: string | null;
  parent_id: string | null;
  draft_version: Generated<number>;
  channel: 'email' | 'sms';
  purpose: 'clarify' | 'reply' | 'holding';
  action_class: string;
  recipient_enc: Buffer;
  body_enc: Buffer;
  sources_enc: Buffer;
  content_digest: Buffer;
  generator: 'template' | 'model' | 'human';
  template_id: string | null;
  model_id: string | null;
  facts_used: string[];
  status: Generated<DraftStatus>;
  outbox_id: string | null;
}
export interface ApprovalsTable extends Meta, Tenant {
  draft_id: string;
  action_class: string;
  content_digest: Buffer;
  approver_id: string;
  input_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}
export interface AutonomyGrantsTable extends Meta, Tenant {
  action_class: string;
  input_id: string;
  granted_by: string;
  evidence: ColumnType<Record<string, unknown>, string, never>;
  revoked_at: Date | null;
  revoke_reason: string | null;
}
export type QuestionKind = 'approve_draft' | 'clarify_edit' | 'owner_task' | 'autonomy_grant' | 'knowledge_update' | 'dsar_release' | 'lifecycle_step' | 'go_live' | 'pack_confirm' | 'complaint';
export type SafeDefault = 'hold' | 'reask' | 'escalate' | 'fail_closed';
export interface HumanQuestionsTable extends Meta, Tenant {
  kind: QuestionKind;
  subject_ref: string;
  action_class: string | null;
  content_digest: Buffer;
  content_version: Generated<number>;
  body_enc: Buffer;
  options: string[];
  safe_default: SafeDefault;
  consumer_kind: string;
  consumer_ref: string;
  required_role: 'owner' | 'approver';
  assigned_user_id: string | null;
  escalation_level: Generated<number>;
  next_escalation_at: Date | null;
  reply_due_at: Date | null;
  deadline_at: Date;
  presented_at: Date;
  clarifications: Generated<number>;
  status: Generated<'open' | 'answered' | 'expired' | 'cancelled' | 'superseded'>;
  closed_reason: string | null;
  subject_contact_id: string | null;
}
export type InputStatus = 'rejected' | 'pending_effect' | 'applied' | 'failed' | 'recorded';
export interface HumanInputsTable extends Meta, Tenant {
  question_id: string;
  kind: string;
  response: string;
  detail_enc: Buffer | null;
  response_digest: Buffer;
  responder_id: string;
  responder_role: string;
  channel: 'app' | 'email' | 'sms' | 'api';
  received_at: Date;
  decision_ms: number | null;
  rubber_stamp: Generated<boolean>;
  status: InputStatus;
  rejection_reason: string | null;
  consumed_by: string | null;
  effect_receipt_id: string | null;
  effect_due_at: Date | null;
  alerted_at: Date | null;
}
export interface EffectReceiptsTable extends Meta, Tenant {
  input_id: string;
  effect_kind: string;
  effect_ref: string;
  outcome: 'done' | 'failed';
  detail: ColumnType<Record<string, unknown>, string | undefined, never>;
}
export type NotificationKind = 'question' | 'ack' | 'outcome' | 'failure' | 'escalation' | 'alert' | 'warning' | 'info';
export interface HumanNotificationsTable extends Meta, Tenant {
  user_id: string;
  kind: NotificationKind;
  ref: string;
  dedupe_key: string;
  body_enc: Buffer;
  channel: Generated<'app' | 'email' | 'sms' | 'push'>;
  status: Generated<'queued' | 'delivered' | 'read'>;
  read_at: Date | null;
  subject_contact_id: string | null;
}

export interface SubjectKeysTable extends Meta, Tenant { subject_ref: string; kek_id: string; wrapped_dek: Buffer | null; state: Generated<'active' | 'shredded'>; shredded_at: Date | null }
export type DsarKind = 'access' | 'erasure' | 'rectification' | 'restriction' | 'objection' | 'portability' | 'unspecified';
export interface DsarRequestsTable extends Meta, Tenant {
  contact_id: string | null;
  source_message_id: string | null;
  kind: DsarKind;
  identity: 'channel_verified' | 'owner_verified' | 'unverified';
  received_at: Date;
  due_at: Date;
  status: Generated<'awaiting_release' | 'releasing' | 'completed' | 'refused' | 'withdrawn'>;
  question_id: string | null;
  export_enc: Buffer | null;
  download_prefix: string | null;
  download_hash: Buffer | null;
  download_expires_at: Date | null;
  downloaded_at: Date | null;
  completed_at: Date | null;
  outcome: string | null;
}
export type ConsentPurpose = 'marketing' | 'reminders' | 'review_requests' | 'updates' | 'partner_referral';
export interface ConsentsTable extends Meta, Tenant {
  contact_id: string;
  purpose: ConsentPurpose;
  channel: 'email' | 'sms' | 'all';
  action: 'granted' | 'withdrawn';
  basis: string;
  source: string;
  wording_version: string | null;
  evidence_ref: string | null;
  recorded_at: Date;
}
export interface ErasureLogTable extends Meta, Tenant {
  subject_ref: string;
  identifiers: Buffer[];
  reason: 'dsar_erasure' | 'retention' | 'tenant_exit';
  request_ref: string | null;
  certificate: ColumnType<Record<string, unknown>, string, never>;
  erased_at: Date;
}
export interface RetentionRunsTable extends Meta, Tenant { ran_at: Date; findings: ColumnType<Record<string, unknown>, string, never> }

export interface OwnerReportsTable extends Meta, Tenant {
  kind: 'weekly';
  period_start: Date;
  period_end: Date;
  metrics: ColumnType<Record<string, unknown>, string, never>;
  body_enc: Buffer;
}
export interface LifecycleSubjectsTable extends Meta, Tenant {
  lifecycle: string;
  definition_version: number;
  definition_hash: string;
  subject_type: string;
  contact_id: string;
  state: string;
  state_seq: Generated<number>;
  state_entered_at: Date;
  anchors: ColumnType<Record<string, string | number>, string | undefined, string>;
}
export type TransitionAuthority = 'system' | 'automatic' | 'grant' | 'approval' | 'human';
export interface LifecycleTransitionsTable extends Meta, Tenant {
  subject_id: string;
  seq: number;
  from_state: string | null;
  to_state: string;
  event: string;
  action_class: string | null;
  authority: TransitionAuthority;
  authority_ref: string | null;
  idempotency_key: string;
  actor: string;
  definition_version: number;
  definition_hash: string;
  occurred_at: Date;
}
export interface LifecycleTimersTable extends Meta, Tenant {
  subject_id: string;
  state_seq: number;
  event: string;
  fires_at: Date;
  status: Generated<'pending' | 'fired' | 'cancelled' | 'stale'>;
  settled_at: Date | null;
}
export interface OfferedWindow { startMs: number; endMs: number; date: string; start: string; end: string }
export interface BookingOffersTable extends Meta, Tenant {
  contact_id: string;
  conversation_id: string;
  enquiry_id: string | null;
  draft_id: string | null;
  service: string | null;
  windows: ColumnType<OfferedWindow[], string, never>;
  reschedule_of: string | null;
  status: Generated<'pending' | 'sent' | 'taken' | 'expired' | 'withdrawn'>;
  offered_at: Date;
  expires_at: Date;
}
export type BookingStatus = 'held' | 'confirmed' | 'released' | 'cancelled' | 'completed' | 'no_show' | 'rescheduled';
export interface BookingsTable extends Meta, Tenant {
  contact_id: string;
  conversation_id: string | null;
  enquiry_id: string | null;
  offer_id: string | null;
  resource: Generated<string>;
  service: string | null;
  starts_at: Date;
  ends_at: Date;
  status: BookingStatus;
  hold_expires_at: Date | null;
  draft_id: string | null;
  cancel_draft_id: string | null;
  replaces_id: string | null;
  confirmed_at: Date | null;
  closed_at: Date | null;
}
export interface LeadSourcesTable extends Meta, Tenant {
  key: string;
  tier: 'A' | 'B' | 'C' | 'D' | 'E';
  type: string;
  lawful_basis: string;
  data_categories: string[];
  acquired_from: string;
  art14_notice_method: string | null;
  retention_days: number;
  counsel_signoff: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  enabled: Generated<boolean>;
}
export interface PurposeRulesTable extends Meta { tier: string; purpose: string; rule: 'allowed' | 'consent' | 'never'; note: string }
export interface TenantActivationsTable extends Meta, Tenant {
  mode: 'active' | 'shadow';
  checklist: ColumnType<unknown, string, never>;
  checklist_ok: boolean;
  input_id: string;
  decided_by: string;
  regulated: boolean;
  platform_decision_id: string | null;
  txid: ColumnType<string, never, never>;
}
export interface TenantPacksTable extends Meta, Tenant {
  pack_version: number;
  body: ColumnType<Record<string, unknown>, string, never>;
  status: Generated<'draft' | 'confirmed' | 'superseded'>;
  test_report: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  test_passed: Generated<boolean>;
  confirmed_by: string | null;
  confirmed_at: Date | null;
}
export interface DataImportsTable extends Meta, Tenant {
  kind: 'contacts';
  lawful_basis: string;
  acquired_from: string;
  imported_by: string;
  rows_in: number;
  rows_imported: number;
  rows_rejected: number;
  lead_source_key: string;
  imported_at: Date;
}
export type LedgerAccount = 'accounts_receivable' | 'revenue' | 'vat_output' | 'processor_clearing' | 'bank' | 'processor_fees' | 'refunds' | 'customer_credit' | 'bad_debt';
export interface LedgerTransactionsTable extends Meta, Tenant {
  kind: 'invoice' | 'payment' | 'fee' | 'refund' | 'credit_note' | 'payout' | 'write_off' | 'adjustment';
  ref: string;
  currency: string;
  occurred_at: Date;
  idempotency_key: string;
}
export interface LedgerEntriesTable extends Meta, Tenant {
  transaction_id: string;
  account: LedgerAccount;
  direction: 'debit' | 'credit';
  amount_minor: ColumnType<string, number | bigint | string, never>;
  contact_id: string | null;
  invoice_id: string | null;
}
export interface InvoiceCountersTable extends Meta { id: Generated<string>; tenant_id: string; region: string; next_number: Generated<number>; prefix: Generated<string> }
export type InvoiceStatus = 'draft' | 'issued' | 'part_paid' | 'paid' | 'void' | 'credited';
export interface InvoicesTable extends Meta, Tenant {
  number: string | null;
  contact_id: string | null;
  booking_id: string | null;
  kind: Generated<'invoice' | 'credit_note'>;
  credits_invoice_id: string | null;
  status: Generated<InvoiceStatus>;
  currency: string;
  vat_treatment: 'inclusive' | 'exclusive' | 'not_registered';
  vat_rate_bp: number;
  net_minor: ColumnType<string, number | string, never>;
  vat_minor: ColumnType<string, number | string, never>;
  total_minor: ColumnType<string, number | string, never>;
  paid_minor: ColumnType<string, number | string | undefined, number | string>;
  issued_at: Date | null;
  due_on: ColumnType<string | null, string | null | undefined, string | null>;
  facts_used: Generated<string[]>;
  send_draft_id: string | null;
}
export interface InvoiceLinesTable extends Meta, Tenant {
  invoice_id: string;
  position: number;
  description: string;
  quantity: number;
  unit_minor: ColumnType<string, number | string, never>;
  amount_minor: ColumnType<string, number | string, never>;
  source_ref: string | null;
}
export interface PaymentLinksTable extends Meta, Tenant {
  invoice_id: string;
  provider: string;
  provider_link_id: string;
  url: string;
  amount_minor: ColumnType<string, number | string, never>;
  currency: string;
  status: Generated<'open' | 'paid' | 'expired' | 'cancelled'>;
}
export interface PaymentEventsTable extends Meta, Tenant {
  provider: string;
  provider_event_id: string;
  kind: 'payment_succeeded' | 'payment_failed' | 'refund_succeeded' | 'fee' | 'payout';
  invoice_id: string | null;
  provider_payment_id: string | null;
  amount_minor: ColumnType<string, number | string, never>;
  fee_minor: ColumnType<string, number | string | undefined, never>;
  currency: string;
  occurred_at: Date;
  ledger_transaction_id: string | null;
}
export interface ReconLinesTable extends Meta, Tenant {
  source: 'processor' | 'bank';
  external_id: string;
  amount_minor: ColumnType<string, number | string, never>;
  currency: string;
  booked_on: ColumnType<string, string, never>;
  reference: string | null;
  payer_hint: string | null;
  status: Generated<'unmatched' | 'matched' | 'suggested' | 'ignored'>;
}
export interface ReconMatchesTable extends Meta, Tenant {
  line_id: string;
  invoice_id: string | null;
  rule: 'exact_reference' | 'amount_date_payer' | 'amount_date' | 'fuzzy';
  confidence: ColumnType<string, number | string, never>;
  outcome: 'matched' | 'partial' | 'overpayment' | 'underpayment' | 'duplicate' | 'unmatched';
  evidence: ColumnType<Record<string, unknown>, string, never>;
  status: 'auto_applied' | 'suggested' | 'confirmed' | 'rejected';
  decided_by: string | null;
}
export interface PlansTable extends Meta {
  id: Generated<string>; region: string; plan_key: string; plan_version: number; name: string; price_minor: ColumnType<string, number | string, never>;
  currency: string; vat_treatment: 'inclusive' | 'exclusive' | 'not_registered'; allowances: ColumnType<Record<string, unknown>, string, never>;
  overage_per_enquiry_minor: ColumnType<string, number | string | undefined, never>; effective_from: ColumnType<string, string, never>; approval_decision_id: string | null;
}
export interface SubscriptionsTable extends Meta, Tenant {
  business_tenant_id: string; contact_id: string; plan_key: string; pilot_until: ColumnType<string | null, string | null | undefined, never>;
  founding_price_minor: ColumnType<string | null, number | null | undefined, never>; founding_lock_until: ColumnType<string | null, string | null | undefined, never>;
  status: Generated<'pilot' | 'active' | 'past_due' | 'suspended' | 'cancelled'>; started_on: ColumnType<string, string, never>;
  period_start: ColumnType<string, string, string>; period_end: ColumnType<string, string, string>; terms_input_id: string;
}
export interface BillingRunsTable extends Meta, Tenant { subscription_id: string; period_start: ColumnType<string, string, never>; period_end: ColumnType<string, string, never>; usage: ColumnType<Record<string, unknown>, string, never>; invoice_id: string | null }
export interface AccountingConnectionsTable extends Meta, Tenant { provider: string; token_enc: Buffer | null; status: Generated<'connected' | 'disconnected' | 'error'>; connected_at: Date; disconnected_at: Date | null }
export interface AccountingMappingsTable extends Meta, Tenant { connection_id: string; local_account: string; external_code: string }
export interface AccountingSyncLogTable extends Meta, Tenant { connection_id: string; entity: 'invoice' | 'payment' | 'credit_note'; entity_id: string; idempotency_key: string; external_id: string | null; status: 'pushed' | 'failed'; error: string | null; attempted_at: Date }
export interface ComplaintCasesTable extends Meta, Tenant {
  contact_id: string | null; enquiry_id: string | null; conversation_id: string | null; category: 'standard' | 'always_human'; reasons: Generated<string[]>;
  status: Generated<'open' | 'remedy_proposed' | 'resolved' | 'closed'>; assigned_user_id: string | null; opened_at: Date; respond_by: Date; breached_at: Date | null; resolved_at: Date | null;
  remedy: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>; root_cause: 'workmanship' | 'communication' | 'price' | 'timing' | 'damage' | 'no_fault' | 'other' | null; satisfaction_opt_in: boolean | null;
}
type ViewOf<T> = { readonly [K in keyof T]: T[K] };
export type MetricsEnquiryFlowView = ViewOf<{
  tenant_id: string; region: string; enquiry_id: string; received_at: Date; analysed_at: Date; route: string; intent: string; intent_source: string; abstained: boolean;
  ack_sent_at: Date | null; first_draft_at: Date | null; reply_sent_at: Date | null; edited: boolean; rejected: boolean; expired: boolean;
}>;
export type MetricsDecisionsView = ViewOf<{ tenant_id: string; region: string; received_at: Date; kind: string; response: string; status: string; decision_ms: number | null; rubber_stamp: boolean; responder_role: string }>;
export type MetricsFloorView = ViewOf<{ tenant_id: string; region: string; outbox_id: string; sent_at: Date | null }>;
export type MetricsUnknownsView = ViewOf<{ tenant_id: string; region: string; analysed_at: Date; missing: string }>;

export interface Database {
  regions: RegionsTable;
  tenants: TenantsTable;
  tenant_keys: TenantKeysTable;
  audit_events: AuditEventsTable;
  audit_checkpoints: AuditCheckpointsTable;
  users: UsersTable;
  contacts: ContactsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  channel_endpoints: ChannelEndpointsTable;
  api_keys: ApiKeysTable;
  job_queue: JobQueueTable;
  knowledge_records: KnowledgeRecordsTable;
  enquiries: EnquiriesTable;
  suppressions: SuppressionsTable;
  outbox: OutboxTable;
  reply_records: ReplyRecordsTable;
  model_registry: ModelRegistryTable;
  user_permissions: UserPermissionsTable;
  approval_routes: ApprovalRoutesTable;
  user_tokens: UserTokensTable;
  operators: OperatorsTable;
  platform_decisions: PlatformDecisionsTable;
  subject_keys: SubjectKeysTable;
  dsar_requests: DsarRequestsTable;
  consents: ConsentsTable;
  erasure_log: ErasureLogTable;
  retention_runs: RetentionRunsTable;
  owner_reports: OwnerReportsTable;
  metrics_enquiry_flow: MetricsEnquiryFlowView;
  metrics_decisions: MetricsDecisionsView;
  metrics_floor_unauthorised_sends: MetricsFloorView;
  metrics_floor_suppressed_sends: MetricsFloorView;
  metrics_unknowns: MetricsUnknownsView;
  drafts: DraftsTable;
  approvals: ApprovalsTable;
  autonomy_grants: AutonomyGrantsTable;
  human_questions: HumanQuestionsTable;
  human_inputs: HumanInputsTable;
  effect_receipts: EffectReceiptsTable;
  human_notifications: HumanNotificationsTable;
  lifecycle_subjects: LifecycleSubjectsTable;
  lifecycle_transitions: LifecycleTransitionsTable;
  lifecycle_timers: LifecycleTimersTable;
  booking_offers: BookingOffersTable;
  bookings: BookingsTable;
  lead_sources: LeadSourcesTable;
  purpose_rules: PurposeRulesTable;
  tenant_activations: TenantActivationsTable;
  tenant_packs: TenantPacksTable;
  data_imports: DataImportsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  invoice_counters: InvoiceCountersTable;
  invoices: InvoicesTable;
  invoice_lines: InvoiceLinesTable;
  payment_links: PaymentLinksTable;
  payment_events: PaymentEventsTable;
  recon_lines: ReconLinesTable;
  recon_matches: ReconMatchesTable;
  plans: PlansTable;
  subscriptions: SubscriptionsTable;
  billing_runs: BillingRunsTable;
  accounting_connections: AccountingConnectionsTable;
  accounting_mappings: AccountingMappingsTable;
  accounting_sync_log: AccountingSyncLogTable;
  complaint_cases: ComplaintCasesTable;
}

export type QuestionRow = Selectable<HumanQuestionsTable>;
export type DraftRow = Selectable<DraftsTable>;
export type BookingRow = Selectable<BookingsTable>;
export type LifecycleSubjectRow = Selectable<LifecycleSubjectsTable>;
