-- 0016 accounts: self-serve sign-up, email sign-in links and Veylith's account emails (§81, R-13).
-- Everything here is Veylith's own record about its customers (the businesses and their people), so it
-- lives in the house tenant (Veylith's account), under the same row-level security, encryption and audit
-- as everything else. A trigger refuses these rows in any other tenant.

CREATE OR REPLACE FUNCTION sevari_meta.house_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.is_house) THEN
    RAISE EXCEPTION '% rows belong to Veylith''s own account (the house tenant) only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- These rows are only ever written in the house tenant's own scope, where its tenants row is visible.

------------------------------------------------------------------------------------------------
-- Sign-up requests: the details someone typed, kept only until they confirm their email (24 hours).
------------------------------------------------------------------------------------------------
CREATE TABLE signup_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  region             region_code NOT NULL,
  prefix             text NOT NULL UNIQUE CHECK (prefix ~ '^sr_[a-z0-9]{12}$'),
  token_hash         bytea NOT NULL,
  email_enc          bytea,
  email_bidx         bytea NOT NULL,
  contact_name_enc   bytea,
  business_name_enc  bytea,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verifying', 'completed', 'expired')),
  new_tenant_id      uuid,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- Once used or expired, the typed details are gone; only the fact of the request stays.
  CHECK (status IN ('pending', 'verifying') OR (email_enc IS NULL AND contact_name_enc IS NULL AND business_name_enc IS NULL)),
  CHECK (status = 'pending' OR status = 'expired' OR new_tenant_id IS NOT NULL)
);
COMMENT ON COLUMN signup_requests.email_enc IS '@pii contact encrypted';
COMMENT ON COLUMN signup_requests.email_bidx IS '@pii contact blind index';
COMMENT ON COLUMN signup_requests.contact_name_enc IS '@pii contact encrypted';
COMMENT ON COLUMN signup_requests.business_name_enc IS '@pii contact encrypted; a sole trader''s business name can be personal data';
CREATE INDEX signup_requests_email ON signup_requests (tenant_id, email_bidx, created_at);
CREATE TRIGGER signup_requests_touch BEFORE UPDATE ON signup_requests FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE TRIGGER signup_requests_house BEFORE INSERT ON signup_requests FOR EACH ROW EXECUTE FUNCTION sevari_meta.house_only();
SELECT sevari_meta.apply_tenant_rls('signup_requests', 'SELECT, INSERT');
GRANT UPDATE (status, new_tenant_id, email_enc, contact_name_enc, business_name_enc) ON signup_requests TO sevari_app;

------------------------------------------------------------------------------------------------
-- The sign-in directory: which business(es) an email address can sign in to. Only a keyed hash of the
-- address is kept here (the address itself stays encrypted on the user's own row in their business).
------------------------------------------------------------------------------------------------
CREATE TABLE account_directory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  region            region_code NOT NULL,
  email_bidx        bytea NOT NULL,
  member_tenant_id  uuid NOT NULL REFERENCES tenants(id),
  member_user_id    uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email_bidx, member_tenant_id, member_user_id)
);
COMMENT ON COLUMN account_directory.email_bidx IS '@pii contact blind index';
CREATE TRIGGER account_directory_touch BEFORE UPDATE ON account_directory FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE TRIGGER account_directory_house BEFORE INSERT ON account_directory FOR EACH ROW EXECUTE FUNCTION sevari_meta.house_only();
SELECT sevari_meta.apply_tenant_rls('account_directory', 'SELECT, INSERT');
GRANT DELETE ON account_directory TO sevari_app;

------------------------------------------------------------------------------------------------
-- Sign-in links (R-13: magic links, short expiry, single use; passkeys come next). Stored as hashes.
------------------------------------------------------------------------------------------------
CREATE TABLE login_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  region            region_code NOT NULL,
  prefix            text NOT NULL UNIQUE CHECK (prefix ~ '^ll_[a-z0-9]{12}$'),
  token_hash        bytea NOT NULL,
  member_tenant_id  uuid NOT NULL REFERENCES tenants(id),
  member_user_id    uuid NOT NULL,
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 minutes')
);
CREATE TRIGGER login_links_touch BEFORE UPDATE ON login_links FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE TRIGGER login_links_house BEFORE INSERT ON login_links FOR EACH ROW EXECUTE FUNCTION sevari_meta.house_only();
SELECT sevari_meta.apply_tenant_rls('login_links', 'SELECT, INSERT');
GRANT UPDATE (used_at) ON login_links TO sevari_app;
GRANT DELETE ON login_links TO sevari_app;

------------------------------------------------------------------------------------------------
-- Veylith's account emails: a fixed set of kinds, written from templates in code, never customer
-- messages (those go through the outbox and its contact rules). The body holds a sign-in link, so it is
-- encrypted, and destroyed once the email has been handed to the provider.
------------------------------------------------------------------------------------------------
CREATE TABLE account_mail (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  region               region_code NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('signup_verify', 'signin_link', 'already_registered', 'brief_ready')),
  recipient_enc        bytea,
  subject              text NOT NULL CHECK (length(subject) <= 200),
  body_enc             bytea,
  state                text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed')),
  attempts             integer NOT NULL DEFAULT 0,
  provider_message_id  text,
  last_error           text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (state = 'pending' OR (recipient_enc IS NULL AND body_enc IS NULL))
);
COMMENT ON COLUMN account_mail.recipient_enc IS '@pii contact encrypted';
COMMENT ON COLUMN account_mail.body_enc IS '@pii contact encrypted; a sign-in link';
CREATE TRIGGER account_mail_touch BEFORE UPDATE ON account_mail FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE TRIGGER account_mail_house BEFORE INSERT ON account_mail FOR EACH ROW EXECUTE FUNCTION sevari_meta.house_only();
SELECT sevari_meta.apply_tenant_rls('account_mail', 'SELECT, INSERT');
GRANT UPDATE (recipient_enc, body_enc, state, attempts, provider_message_id, last_error, sent_at) ON account_mail TO sevari_app;
