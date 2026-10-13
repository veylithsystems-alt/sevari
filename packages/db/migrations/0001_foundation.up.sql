-- 0001 foundation: regions, tenancy, RLS machinery, audit chain, key store, transfer contracts,
-- and the first tenant-scoped entities. Contract §3 (INV-1, 2, 7, 8), §5.1, §6.
--
-- Conventions every tenant-scoped table follows (enforced by the schema lint test, INV-7):
--   id uuid, tenant_id uuid NOT NULL, region region_code NOT NULL, created_at, updated_at, version
--   RLS enabled + FORCED, policy via sevari_meta.apply_tenant_rls()
--   UNIQUE (tenant_id, id) so child tables use composite foreign keys: a row can never
--   reference another tenant's row, even by mistake.
--   Personal-data columns carry a COMMENT starting with '@pii <category>' (§6.4 registry check).

CREATE SCHEMA sevari_meta AUTHORIZATION sevari_owner;
GRANT USAGE ON SCHEMA sevari_meta TO sevari_app;

-- Region codes are data, not an enum: adding region #2 is a row, not a code change (§1).
CREATE DOMAIN region_code AS text CHECK (VALUE ~ '^[a-z][a-z0-9]{1,7}$');

-- Session context. Missing settings yield NULL, and NULL never equals anything, so RLS fails closed.
CREATE FUNCTION sevari_meta.app_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION sevari_meta.app_region() RETURNS region_code
  LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT nullif(current_setting('app.region', true), '')::region_code $$;
GRANT EXECUTE ON FUNCTION sevari_meta.app_tenant(), sevari_meta.app_region() TO sevari_app;

CREATE FUNCTION sevari_meta.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

------------------------------------------------------------------------------------------------
-- Regions (cell configuration). No personal data.
------------------------------------------------------------------------------------------------
CREATE TABLE regions (
  code               region_code PRIMARY KEY,
  name               text NOT NULL,
  -- §8.4: the cell refuses live tenants while this is null. Recorded by a human, never by the app.
  counsel_signoff    jsonb,
  signoff_expires_on date,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1
);
CREATE TRIGGER regions_touch BEFORE UPDATE ON regions FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE regions FORCE ROW LEVEL SECURITY;
CREATE POLICY regions_read ON regions FOR SELECT TO sevari_app USING (true);
GRANT SELECT ON regions TO sevari_app;

------------------------------------------------------------------------------------------------
-- Tenants. tenant_id mirrors id so the uniform isolation policy applies.
------------------------------------------------------------------------------------------------
CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid GENERATED ALWAYS AS (id) STORED NOT NULL,
  region       region_code NOT NULL REFERENCES regions(code),
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'onboarding'
               CHECK (status IN ('prospect', 'onboarding', 'shadow', 'active', 'suspended', 'offboarding', 'closed')),
  is_house     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON COLUMN tenants.display_name IS '@pii contact business or trading name; a sole trader''s name is personal data';
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();

------------------------------------------------------------------------------------------------
-- Region transfer contracts (INV-2). Written only by humans through the owner role, never by the app.
------------------------------------------------------------------------------------------------
CREATE TABLE region_transfer_contracts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL REFERENCES regions(code),
  to_region      region_code NOT NULL REFERENCES regions(code),
  tables         text[] NOT NULL CHECK (cardinality(tables) > 0),
  purpose        text NOT NULL,
  legal_basis    text NOT NULL,
  approved_by    text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  CHECK (region <> to_region),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE TRIGGER rtc_touch BEFORE UPDATE ON region_transfer_contracts FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();

-- A write may target the session region, or another region only under an active transfer contract.
CREATE FUNCTION sevari_meta.region_write_allowed(p_tenant uuid, p_region region_code, p_table text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_region = sevari_meta.app_region()
      OR EXISTS (
        SELECT 1 FROM region_transfer_contracts c
         WHERE c.tenant_id = p_tenant
           AND c.region = sevari_meta.app_region()
           AND c.to_region = p_region
           AND (p_table = ANY (c.tables) OR '*' = ANY (c.tables))
           AND clock_timestamp() >= c.effective_from
           AND (c.effective_to IS NULL OR clock_timestamp() < c.effective_to))
$$;
GRANT EXECUTE ON FUNCTION sevari_meta.region_write_allowed(uuid, region_code, text) TO sevari_app;

-- The one way a tenant-scoped table gets its isolation policy.
CREATE FUNCTION sevari_meta.apply_tenant_rls(p_table regclass, p_app_grants text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t text := p_table::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO sevari_app '
    'USING (tenant_id = sevari_meta.app_tenant() AND region = sevari_meta.app_region()) '
    'WITH CHECK (tenant_id = sevari_meta.app_tenant() AND sevari_meta.region_write_allowed(tenant_id, region, %L))',
    t, t);
  IF p_app_grants IS NOT NULL AND p_app_grants <> '' THEN
    EXECUTE format('GRANT %s ON %s TO sevari_app', p_app_grants, t);
  END IF;
END $$;

SELECT sevari_meta.apply_tenant_rls('tenants', 'SELECT, INSERT, UPDATE');
-- The transfer contracts are readable (the policy function needs them) but never writable by the app.
SELECT sevari_meta.apply_tenant_rls('region_transfer_contracts', 'SELECT');

------------------------------------------------------------------------------------------------
-- Envelope encryption key store (§6.3). Wrapped DEKs only; KEKs never touch the database.
-- Crypto-shred = wrapped_dek set to NULL and state 'shredded' (§6.3, erasure).
------------------------------------------------------------------------------------------------
CREATE TABLE tenant_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  key_version  integer NOT NULL CHECK (key_version > 0),
  purpose      text NOT NULL DEFAULT 'data' CHECK (purpose IN ('data', 'blind_index')),
  kek_id       text NOT NULL,
  wrapped_dek  bytea,
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired', 'shredded')),
  shredded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, purpose, key_version),
  CHECK ((state = 'shredded') = (wrapped_dek IS NULL)),
  CHECK ((state = 'shredded') = (shredded_at IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_keys_one_active ON tenant_keys (tenant_id, purpose) WHERE state = 'active';
CREATE TRIGGER tenant_keys_touch BEFORE UPDATE ON tenant_keys FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
-- A shredded key stays shredded.
CREATE FUNCTION sevari_meta.tenant_keys_no_unshred() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'shredded' AND NEW.state <> 'shredded' THEN
    RAISE EXCEPTION 'tenant key % is shredded and cannot be restored', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_keys_no_unshred BEFORE UPDATE ON tenant_keys FOR EACH ROW EXECUTE FUNCTION sevari_meta.tenant_keys_no_unshred();
SELECT sevari_meta.apply_tenant_rls('tenant_keys', 'SELECT, INSERT');
GRANT UPDATE (state, wrapped_dek, shredded_at) ON tenant_keys TO sevari_app;

------------------------------------------------------------------------------------------------
-- Audit chain (INV-8). Append-only, hash-chained per (tenant, region), computed by the database.
-- The application cannot choose seq, prev_hash, hash or created_at: the trigger overwrites them.
-- Audit rows hold no personal data: subjects are referenced by id, content by digest. So erasure
-- never needs to alter the audit chain (crypto-shredding removes the content it points at).
------------------------------------------------------------------------------------------------
CREATE TABLE audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  seq         bigint NOT NULL,
  event_type  text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,79}$'),
  actor_kind  text NOT NULL CHECK (actor_kind IN ('system', 'user', 'provider', 'customer', 'operator')),
  actor_ref   text,
  subject_ref text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   bytea NOT NULL,
  hash        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, region, seq),
  UNIQUE (tenant_id, id)
);

CREATE FUNCTION sevari_meta.audit_genesis(p_tenant uuid, p_region region_code) RETURNS bytea
  LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to('sevari-audit-genesis:' || p_tenant::text || ':' || p_region, 'UTF8')) $$;

-- Unambiguous material: a JSON array, so no field can smuggle a delimiter.
CREATE FUNCTION sevari_meta.audit_material(e audit_events) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_to(jsonb_build_array(
    e.tenant_id, e.region, e.seq, e.event_type, e.actor_kind, e.actor_ref, e.subject_ref, e.payload,
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'UTF8')
$$;

CREATE FUNCTION sevari_meta.audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash bytea;
BEGIN
  -- Serialise appends per chain. Statement-level snapshots under READ COMMITTED see the
  -- previous writer's committed row once the lock is granted.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text || ':' || NEW.region, 0));
  SELECT a.seq, a.hash INTO last_seq, last_hash
    FROM audit_events a
   WHERE a.tenant_id = NEW.tenant_id AND a.region = NEW.region
   ORDER BY a.seq DESC LIMIT 1;
  NEW.seq        := coalesce(last_seq, 0) + 1;
  NEW.prev_hash  := coalesce(last_hash, sevari_meta.audit_genesis(NEW.tenant_id, NEW.region));
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  NEW.version    := 1;
  NEW.hash       := sha256(NEW.prev_hash || sevari_meta.audit_material(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION sevari_meta.audit_chain();

-- Defence in depth beyond grants: nobody, including the owner role, updates or deletes audit rows.
CREATE FUNCTION sevari_meta.audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (INV-8)' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION sevari_meta.audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION sevari_meta.audit_immutable();

SELECT sevari_meta.apply_tenant_rls('audit_events', 'SELECT, INSERT');

-- Verification: returns the first broken seq for the session's chain, or NULL when intact.
CREATE FUNCTION sevari_meta.audit_verify(p_from_seq bigint DEFAULT 1)
RETURNS TABLE (broken_seq bigint, reason text) LANGUAGE plpgsql STABLE AS $$
DECLARE
  e         audit_events;
  expected_prev bytea;
  expected_seq  bigint;
BEGIN
  expected_seq := p_from_seq;
  IF p_from_seq = 1 THEN
    expected_prev := sevari_meta.audit_genesis(sevari_meta.app_tenant(), sevari_meta.app_region());
  ELSE
    SELECT a.hash INTO expected_prev FROM audit_events a WHERE a.seq = p_from_seq - 1;
  END IF;
  FOR e IN SELECT * FROM audit_events a WHERE a.seq >= p_from_seq ORDER BY a.seq LOOP
    IF e.seq <> expected_seq THEN
      broken_seq := expected_seq; reason := 'gap'; RETURN NEXT; RETURN;
    END IF;
    IF e.prev_hash <> expected_prev THEN
      broken_seq := e.seq; reason := 'prev_hash_mismatch'; RETURN NEXT; RETURN;
    END IF;
    IF e.hash <> sha256(e.prev_hash || sevari_meta.audit_material(e)) THEN
      broken_seq := e.seq; reason := 'hash_mismatch'; RETURN NEXT; RETURN;
    END IF;
    expected_prev := e.hash;
    expected_seq := e.seq + 1;
  END LOOP;
  RETURN;
END $$;
GRANT EXECUTE ON FUNCTION sevari_meta.audit_verify(bigint) TO sevari_app;

-- Signed checkpoints anchor the chain head with a key held outside the database, so even a
-- database superuser who rewrites the whole chain cannot forge the earlier signed heads.
CREATE TABLE audit_checkpoints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  region     region_code NOT NULL,
  seq        bigint NOT NULL,
  head_hash  bytea NOT NULL,
  key_id     text NOT NULL,
  signature  bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version    integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, region, seq)
);
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE OR DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION sevari_meta.audit_immutable();
SELECT sevari_meta.apply_tenant_rls('audit_checkpoints', 'SELECT, INSERT');

------------------------------------------------------------------------------------------------
-- Users of a tenant (owner, staff, delegates). Multi-user from day one (§1).
------------------------------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  region           region_code NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner', 'staff', 'delegate', 'viewer')),
  display_name_enc bytea NOT NULL,
  email_enc        bytea,
  email_bidx       bytea,
  phone_enc        bytea,
  phone_bidx       bytea,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON COLUMN users.display_name_enc IS '@pii contact encrypted';
COMMENT ON COLUMN users.email_enc IS '@pii contact encrypted';
COMMENT ON COLUMN users.email_bidx IS '@pii contact blind index';
COMMENT ON COLUMN users.phone_enc IS '@pii contact encrypted';
COMMENT ON COLUMN users.phone_bidx IS '@pii contact blind index';
CREATE INDEX users_email_bidx ON users (tenant_id, email_bidx);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('users', 'SELECT, INSERT, UPDATE');

------------------------------------------------------------------------------------------------
-- Contacts: the people a tenant deals with. Provenance is NOT NULL, so a contact without
-- provenance cannot exist, let alone be messaged (§17.2, F10).
------------------------------------------------------------------------------------------------
CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  region           region_code NOT NULL,
  display_name_enc bytea,
  email_enc        bytea,
  email_bidx       bytea,
  phone_enc        bytea,
  phone_bidx       bytea,
  -- §17.2 / §43: unknown is treated as an individual (F11).
  subscriber_type  text NOT NULL DEFAULT 'unknown'
                   CHECK (subscriber_type IN ('unknown', 'individual', 'sole_trader', 'partnership', 'company', 'public_body')),
  source           text NOT NULL,
  lawful_basis     text NOT NULL,
  captured_at      timestamptz NOT NULL,
  captured_by      text NOT NULL,
  vulnerable_flag  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
COMMENT ON COLUMN contacts.display_name_enc IS '@pii contact encrypted';
COMMENT ON COLUMN contacts.email_enc IS '@pii contact encrypted';
COMMENT ON COLUMN contacts.email_bidx IS '@pii contact blind index';
COMMENT ON COLUMN contacts.phone_enc IS '@pii contact encrypted';
COMMENT ON COLUMN contacts.phone_bidx IS '@pii contact blind index';
COMMENT ON COLUMN contacts.vulnerable_flag IS '@pii special vulnerability marker; never inferred by a model';
CREATE INDEX contacts_email_bidx ON contacts (tenant_id, email_bidx);
CREATE INDEX contacts_phone_bidx ON contacts (tenant_id, phone_bidx);
CREATE TRIGGER contacts_touch BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('contacts', 'SELECT, INSERT, UPDATE, DELETE');

------------------------------------------------------------------------------------------------
-- Conversations and messages: one conversation per contact across channels (§22).
------------------------------------------------------------------------------------------------
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  contact_id  uuid NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'waiting_owner', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE TRIGGER conversations_touch BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('conversations', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  region              region_code NOT NULL,
  conversation_id     uuid NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel             text NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_message_id text NOT NULL,
  body_enc            bytea NOT NULL,
  body_digest         bytea NOT NULL,
  received_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- Idempotency: replaying a provider webhook can never create a second message (T-IDEM, F42).
  UNIQUE (tenant_id, channel, direction, provider_message_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON COLUMN messages.body_enc IS '@pii contact encrypted message body';
COMMENT ON COLUMN messages.body_digest IS '@pii contact keyed digest of body (tenant HMAC), not reversible';
CREATE TRIGGER messages_touch BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('messages', 'SELECT, INSERT, DELETE');

-- Migration ledger lives in sevari_meta; the app may read it (boot check: migrations current).
GRANT SELECT ON ALL TABLES IN SCHEMA sevari_meta TO sevari_app;
