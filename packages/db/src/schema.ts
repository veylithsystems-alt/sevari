import type { ColumnType, Generated } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, never>;
type Meta = { created_at: Ts; updated_at: Ts; version: ColumnType<number, never, never> };

export interface RegionsTable extends Meta {
  code: string;
  name: string;
  counsel_signoff: unknown | null;
  signoff_expires_on: Date | null;
}
export interface TenantsTable extends Meta {
  id: Generated<string>;
  tenant_id: ColumnType<string, never, never>;
  region: string;
  display_name: string;
  status: Generated<'prospect' | 'onboarding' | 'shadow' | 'active' | 'suspended' | 'offboarding' | 'closed'>;
  is_house: Generated<boolean>;
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
  role: 'owner' | 'staff' | 'delegate' | 'viewer';
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
}

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
}
