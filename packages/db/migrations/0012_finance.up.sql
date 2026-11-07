-- 0012 finance (Part B §19, Phase 12): ledger, invoices, payment links and events, reconciliation.
-- Money is integer minor units with a currency. Sevari never holds funds: in the default mode (Mode 1,
-- direct) the customer pays the business's own processor account. Mode 2 (platform) exists only behind
-- counsel's sign-off (§19.1); nothing here can move money on its own.

-- Tax and payment terms per region, as data (§19.2: tax rule from region config), synced from the rule pack.
ALTER TABLE regions ADD COLUMN tax_rules jsonb NOT NULL DEFAULT '{ "currency": "GBP", "vat_standard_rate_bp": 2000, "payment_terms_days": 14 }'::jsonb;

-- How money flows for this business (§19.1). 'platform' can't be set without a recorded sign-off.
ALTER TABLE tenants ADD COLUMN money_mode text NOT NULL DEFAULT 'direct' CHECK (money_mode IN ('direct', 'platform_signed_off'));
ALTER TABLE tenants ADD COLUMN money_mode_signoff uuid REFERENCES platform_decisions(id);
ALTER TABLE tenants ADD CONSTRAINT tenants_money_mode_signed CHECK (money_mode = 'direct' OR money_mode_signoff IS NOT NULL);
CREATE FUNCTION sevari_meta.tenants_money_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.money_mode IS DISTINCT FROM OLD.money_mode AND current_user <> 'sevari_owner' THEN
    RAISE EXCEPTION 'the money mode is a platform decision (§19.1), never changed by the app' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_money_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION sevari_meta.tenants_money_guard();

------------------------------------------------------------------------------------------------
-- Ledger (§19.2): append-only, double-entry, per business. Each transaction's debits equal its credits,
-- checked by the database at commit (F15). No updates, no deletes: corrections are new transactions.
------------------------------------------------------------------------------------------------
CREATE TABLE ledger_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('invoice', 'payment', 'fee', 'refund', 'credit_note', 'payout', 'write_off', 'adjustment')),
  ref         text NOT NULL,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
SELECT sevari_meta.apply_tenant_rls('ledger_transactions', 'SELECT, INSERT');

CREATE TABLE ledger_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  transaction_id uuid NOT NULL,
  account        text NOT NULL CHECK (account IN ('accounts_receivable', 'revenue', 'vat_output', 'processor_clearing', 'bank', 'processor_fees', 'refunds', 'customer_credit', 'bad_debt')),
  direction      text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  contact_id     uuid,
  invoice_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES ledger_transactions (tenant_id, id),
  -- Erasing a person keeps the money record (tax rules) and drops the link to them (§19.6).
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX ledger_entries_tx ON ledger_entries (tenant_id, transaction_id);
CREATE INDEX ledger_entries_invoice ON ledger_entries (tenant_id, invoice_id);
SELECT sevari_meta.apply_tenant_rls('ledger_entries', 'SELECT, INSERT');

CREATE FUNCTION sevari_meta.ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tx uuid;
  v_debit bigint;
  v_credit bigint;
  v_n integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN v_tx := NEW.transaction_id; ELSE v_tx := NEW.id; END IF;
  SELECT COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0), COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0), count(*)
    INTO v_debit, v_credit, v_n FROM ledger_entries WHERE transaction_id = v_tx;
  IF v_n < 2 OR v_debit <> v_credit THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (debits %, credits %, entries %)', v_tx, v_debit, v_credit, v_n USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Checked at commit, so a transaction's lines can be written one by one; an unbalanced one never lands.
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sevari_meta.ledger_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sevari_meta.ledger_balanced();

------------------------------------------------------------------------------------------------
-- Invoices (§19.2): generated deterministically from records the owner confirmed. Gapless numbers per
-- business. Issued invoices never change: corrections are credit notes.
------------------------------------------------------------------------------------------------
CREATE TABLE invoice_counters (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  region     region_code NOT NULL,
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number > 0),
  prefix     text NOT NULL DEFAULT 'INV-',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version    integer NOT NULL DEFAULT 1,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  UNIQUE (tenant_id, id)
);
SELECT sevari_meta.apply_tenant_rls('invoice_counters', 'SELECT, INSERT');
GRANT UPDATE (next_number) ON invoice_counters TO sevari_app;

CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  number         text,
  -- Null once the person is erased: the invoice itself is a tax record and is kept (§19.6).
  contact_id     uuid,
  booking_id     uuid,
  kind           text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'credit_note')),
  credits_invoice_id uuid,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'part_paid', 'paid', 'void', 'credited')),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  vat_treatment  text NOT NULL CHECK (vat_treatment IN ('inclusive', 'exclusive', 'not_registered')),
  vat_rate_bp    integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  net_minor      bigint NOT NULL CHECK (net_minor >= 0),
  vat_minor      bigint NOT NULL CHECK (vat_minor >= 0),
  total_minor    bigint NOT NULL CHECK (total_minor >= 0),
  paid_minor     bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  issued_at      timestamptz,
  due_on         date,
  facts_used     text[] NOT NULL DEFAULT '{}',
  -- The message that sends it: the invoice is issued (numbered, posted) only when that send is authorised.
  send_draft_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (total_minor = net_minor + vat_minor),
  CHECK (status = 'draft' OR (number IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (kind = 'invoice' OR credits_invoice_id IS NOT NULL),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id) ON DELETE SET NULL (booking_id),
  FOREIGN KEY (tenant_id, credits_invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, send_draft_id) REFERENCES drafts (tenant_id, id) ON DELETE SET NULL (send_draft_id)
);
CREATE INDEX invoices_open ON invoices (tenant_id, status, due_on);
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE FUNCTION sevari_meta.invoices_issued_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.net_minor <> OLD.net_minor OR NEW.vat_minor <> OLD.vat_minor OR NEW.total_minor <> OLD.total_minor
      OR NEW.currency <> OLD.currency OR (NEW.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id) OR NEW.number IS DISTINCT FROM OLD.number OR NEW.issued_at IS DISTINCT FROM OLD.issued_at) THEN
    RAISE EXCEPTION 'invoice % is issued: amounts and number never change (use a credit note)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.paid_minor > NEW.total_minor THEN
    RAISE EXCEPTION 'invoice % would be overpaid; overpayments go to customer credit', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_issued_immutable BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION sevari_meta.invoices_issued_immutable();
SELECT sevari_meta.apply_tenant_rls('invoices', 'SELECT, INSERT');
GRANT UPDATE (status, paid_minor, number, issued_at, due_on, send_draft_id) ON invoices TO sevari_app;

CREATE TABLE invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  invoice_id   uuid NOT NULL,
  position     integer NOT NULL CHECK (position > 0),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  quantity     integer NOT NULL CHECK (quantity > 0),
  unit_minor   bigint NOT NULL CHECK (unit_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  source_ref   text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, position),
  CHECK (amount_minor = quantity * unit_minor),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
COMMENT ON COLUMN invoice_lines.description IS 'service names from the owner''s records; never message text or addresses';
SELECT sevari_meta.apply_tenant_rls('invoice_lines', 'SELECT, INSERT');

------------------------------------------------------------------------------------------------
-- Payments (§19.2): links made by the business's own processor, and the processor's events, each
-- recorded once however many times it is delivered (F16).
------------------------------------------------------------------------------------------------
CREATE TABLE payment_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  region            region_code NOT NULL,
  invoice_id        uuid NOT NULL,
  provider          text NOT NULL,
  provider_link_id  text NOT NULL,
  url               text NOT NULL CHECK (url ~ '^https://'),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  currency          text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'cancelled')),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_link_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE TRIGGER payment_links_touch BEFORE UPDATE ON payment_links FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('payment_links', 'SELECT, INSERT');
GRANT UPDATE (status) ON payment_links TO sevari_app;

CREATE TABLE payment_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  region             region_code NOT NULL,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('payment_succeeded', 'payment_failed', 'refund_succeeded', 'fee', 'payout')),
  invoice_id         uuid,
  provider_payment_id text,
  amount_minor       bigint NOT NULL CHECK (amount_minor >= 0),
  fee_minor          bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency           text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  ledger_transaction_id uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_event_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
SELECT sevari_meta.apply_tenant_rls('payment_events', 'SELECT, INSERT');
GRANT UPDATE (ledger_transaction_id) ON payment_events TO sevari_app;

------------------------------------------------------------------------------------------------
-- Reconciliation (§19.3): lines from processor payout reports and bank feeds (each once, F16), and the
-- matching decisions with their rule, confidence and evidence. Only exact or high-confidence matches are
-- applied automatically (F17); everything else waits for a person.
------------------------------------------------------------------------------------------------
CREATE TABLE recon_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  region        region_code NOT NULL,
  source        text NOT NULL CHECK (source IN ('processor', 'bank')),
  external_id   text NOT NULL,
  amount_minor  bigint NOT NULL,
  currency      text NOT NULL,
  booked_on     date NOT NULL,
  reference     text,
  payer_hint    text,
  status        text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'suggested', 'ignored')),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source, external_id)
);
COMMENT ON COLUMN recon_lines.payer_hint IS '@pii financial payer name or reference as printed on the statement';
CREATE TRIGGER recon_lines_touch BEFORE UPDATE ON recon_lines FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('recon_lines', 'SELECT, INSERT');
GRANT UPDATE (status) ON recon_lines TO sevari_app;

CREATE TABLE recon_matches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  line_id      uuid NOT NULL,
  invoice_id   uuid,
  rule         text NOT NULL CHECK (rule IN ('exact_reference', 'amount_date_payer', 'amount_date', 'fuzzy')),
  confidence   numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  outcome      text NOT NULL CHECK (outcome IN ('matched', 'partial', 'overpayment', 'underpayment', 'duplicate', 'unmatched')),
  evidence     jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('auto_applied', 'suggested', 'confirmed', 'rejected')),
  decided_by   text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  -- F17 in the database: nothing below the threshold is ever applied without a person.
  CHECK (status <> 'auto_applied' OR (confidence >= 0.95 AND rule IN ('exact_reference', 'amount_date_payer'))),
  FOREIGN KEY (tenant_id, line_id) REFERENCES recon_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE TRIGGER recon_matches_touch BEFORE UPDATE ON recon_matches FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('recon_matches', 'SELECT, INSERT');
GRANT UPDATE (status, decided_by) ON recon_matches TO sevari_app;
