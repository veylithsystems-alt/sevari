-- 0006 human input and approvals: tenant roles and permissions (§82), credentials, drafts, approvals
-- (§7.1, I8), autonomy grants (§7.2), structured questions, inputs and effect receipts (§30, INV-12..16),
-- notifications to humans (§74), and platform operators (§82 platform scope).

------------------------------------------------------------------------------------------------
-- Tenant roles (§82): owner, approver (limited to granted action classes), viewer.
------------------------------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'approver', 'viewer'));
CREATE UNIQUE INDEX users_one_owner ON users (tenant_id) WHERE role = 'owner' AND status = 'active';

-- Which action classes a non-owner may approve. Money classes need an explicit row like any other.
CREATE TABLE user_permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  user_id      uuid NOT NULL,
  action_class text NOT NULL,
  granted_by   uuid NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX user_permissions_active ON user_permissions (tenant_id, user_id, action_class) WHERE revoked_at IS NULL;
CREATE TRIGGER user_permissions_touch BEFORE UPDATE ON user_permissions FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('user_permissions', 'SELECT, INSERT');
GRANT UPDATE (revoked_at) ON user_permissions TO sevari_app;

-- The owner's escalation order: who is asked next, and after how long (§82, F57).
CREATE TABLE approval_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  region        region_code NOT NULL,
  position      integer NOT NULL CHECK (position >= 1),
  user_id       uuid NOT NULL,
  after_minutes integer NOT NULL CHECK (after_minutes BETWEEN 1 AND 10080),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, position),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER approval_routes_touch BEFORE UPDATE ON approval_routes FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('approval_routes', 'SELECT, INSERT, UPDATE, DELETE');

-- Tenant user credentials (owner app sessions). Passkeys replace bearer tokens before pilots (R-12, DEV-013).
CREATE TABLE user_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  user_id      uuid NOT NULL,
  prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^ut_[a-z0-9]{12}$'),
  token_hash   bytea NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER user_tokens_touch BEFORE UPDATE ON user_tokens FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('user_tokens', 'SELECT, INSERT');
GRANT UPDATE (status) ON user_tokens TO sevari_app;
CREATE POLICY user_token_lookup ON user_tokens FOR SELECT TO sevari_app
  USING (prefix = nullif(current_setting('app.user_token_prefix', true), '') AND status = 'active');

------------------------------------------------------------------------------------------------
-- Platform operators (§82 platform scope). Cell-global; never a tenant user. An operator credential
-- can make platform decisions and can never approve a tenant action (F58).
------------------------------------------------------------------------------------------------
CREATE TABLE operators (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^op_[a-z0-9]{12}$'),
  token_hash   bytea NOT NULL,
  -- founder: Dan (platform authority, §82). counsel: legal sign-offs only. operator: other Veylith staff.
  role         text NOT NULL DEFAULT 'operator' CHECK (role IN ('founder', 'operator', 'counsel')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN operators.display_name IS '@pii contact operator name';
CREATE TRIGGER operators_touch BEFORE UPDATE ON operators FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_lookup ON operators FOR SELECT TO sevari_app
  USING (prefix = nullif(current_setting('app.operator_prefix', true), '') AND status = 'active');
CREATE POLICY operators_admin ON operators FOR ALL TO sevari_owner USING (true) WITH CHECK (true);
GRANT SELECT ON operators TO sevari_app;

------------------------------------------------------------------------------------------------
-- Drafts: what would be sent, exactly. Immutable content; an edit is a new version.
------------------------------------------------------------------------------------------------
CREATE TABLE drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  region          region_code NOT NULL,
  enquiry_id      uuid,
  conversation_id uuid NOT NULL,
  contact_id      uuid NOT NULL,
  in_reply_to     uuid,
  parent_id       uuid,
  draft_version   integer NOT NULL DEFAULT 1 CHECK (draft_version >= 1),
  channel         text NOT NULL CHECK (channel IN ('email', 'sms')),
  purpose         text NOT NULL CHECK (purpose IN ('clarify', 'reply', 'holding')),
  action_class    text NOT NULL,
  recipient_enc   bytea NOT NULL,
  body_enc        bytea NOT NULL,
  -- The grounding sources the draft was checked against (fact texts, service facts, customer text),
  -- so the check can be re-run at approval time with exactly the same evidence.
  sources_enc     bytea NOT NULL,
  -- SHA-256 of the canonical payload {action_class, channel, recipient, body} (§7.1).
  content_digest  bytea NOT NULL,
  generator       text NOT NULL CHECK (generator IN ('template', 'model', 'human')),
  template_id     text,
  model_id        text,
  facts_used      text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval', 'approved', 'rejected', 'superseded', 'expired', 'sent', 'failed', 'blocked')),
  outbox_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, enquiry_id) REFERENCES enquiries (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, in_reply_to) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (in_reply_to),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES drafts (tenant_id, id),
  FOREIGN KEY (tenant_id, outbox_id) REFERENCES outbox (tenant_id, id)
);
COMMENT ON COLUMN drafts.recipient_enc IS '@pii contact encrypted recipient';
COMMENT ON COLUMN drafts.body_enc IS '@pii contact encrypted draft text';
COMMENT ON COLUMN drafts.sources_enc IS '@pii contact encrypted grounding sources (includes the customer''s message)';
COMMENT ON COLUMN drafts.content_digest IS '@pii contact digest of the exact payload (approval binding)';
CREATE INDEX drafts_enquiry ON drafts (tenant_id, enquiry_id);
CREATE TRIGGER drafts_touch BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
CREATE FUNCTION sevari_meta.draft_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.recipient_enc IS DISTINCT FROM OLD.recipient_enc
     OR NEW.content_digest IS DISTINCT FROM OLD.content_digest OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.sources_enc IS DISTINCT FROM OLD.sources_enc
     OR NEW.action_class IS DISTINCT FROM OLD.action_class THEN
    RAISE EXCEPTION 'draft content is immutable; an edit is a new draft version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drafts_content_immutable BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION sevari_meta.draft_content_immutable();
SELECT sevari_meta.apply_tenant_rls('drafts', 'SELECT, INSERT');
GRANT UPDATE (status, outbox_id) ON drafts TO sevari_app;

------------------------------------------------------------------------------------------------
-- Approvals (§7.1, I8): single-use, expiring, bound to the exact content digest.
------------------------------------------------------------------------------------------------
CREATE TABLE approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  region         region_code NOT NULL,
  draft_id       uuid NOT NULL,
  action_class   text NOT NULL,
  content_digest bytea NOT NULL,
  approver_id    uuid NOT NULL,
  input_id       uuid NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (expires_at > created_at),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES drafts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES users (tenant_id, id)
);
COMMENT ON COLUMN approvals.content_digest IS '@pii contact digest of the approved payload';
CREATE TRIGGER approvals_touch BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
-- Once consumed, an approval can never be un-consumed or re-pointed.
CREATE FUNCTION sevari_meta.approval_single_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
     OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'approvals are single-use and immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_single_use BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION sevari_meta.approval_single_use();
SELECT sevari_meta.apply_tenant_rls('approvals', 'SELECT, INSERT');
GRANT UPDATE (consumed_at) ON approvals TO sevari_app;

------------------------------------------------------------------------------------------------
-- Autonomy grants (§7.2). Reserved classes can never be granted, whatever the code or config says (INV-11).
------------------------------------------------------------------------------------------------
CREATE TABLE autonomy_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  region        region_code NOT NULL,
  action_class  text NOT NULL CHECK (action_class NOT IN ('ack', 'refund', 'payment_request', 'cancel')),
  input_id      uuid NOT NULL,
  granted_by    uuid NOT NULL,
  evidence      jsonb NOT NULL,
  revoked_at    timestamptz,
  revoke_reason text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX autonomy_grants_active ON autonomy_grants (tenant_id, action_class) WHERE revoked_at IS NULL;
CREATE TRIGGER autonomy_grants_touch BEFORE UPDATE ON autonomy_grants FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('autonomy_grants', 'SELECT, INSERT');
GRANT UPDATE (revoked_at, revoke_reason) ON autonomy_grants TO sevari_app;
-- A revoked grant stays revoked: a new grant needs a new human decision (§7.2 kill switch).
CREATE FUNCTION sevari_meta.grant_no_unrevoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked grant cannot be reinstated' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER autonomy_grants_no_unrevoke BEFORE UPDATE ON autonomy_grants FOR EACH ROW EXECUTE FUNCTION sevari_meta.grant_no_unrevoke();

------------------------------------------------------------------------------------------------
-- Structured questions to humans (§30.3). Every question names its consumer (INV-12) and its safe
-- default; the safe default is never "approve" (INV-14).
------------------------------------------------------------------------------------------------
CREATE TABLE human_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  region             region_code NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update')),
  subject_ref        text NOT NULL,
  action_class       text,
  content_digest     bytea NOT NULL,
  content_version    integer NOT NULL DEFAULT 1,
  body_enc           bytea NOT NULL,
  options            text[] NOT NULL CHECK (cardinality(options) > 0),
  safe_default       text NOT NULL CHECK (safe_default IN ('hold', 'reask', 'escalate', 'fail_closed')),
  consumer_kind      text NOT NULL CHECK (length(consumer_kind) > 0),
  consumer_ref       text NOT NULL CHECK (length(consumer_ref) > 0),
  required_role      text NOT NULL CHECK (required_role IN ('owner', 'approver')),
  assigned_user_id   uuid,
  escalation_level   integer NOT NULL DEFAULT 0,
  next_escalation_at timestamptz,
  reply_due_at       timestamptz,
  deadline_at        timestamptz NOT NULL,
  presented_at       timestamptz NOT NULL,
  clarifications     integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired', 'cancelled', 'superseded')),
  closed_reason      text,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (deadline_at > presented_at),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users (tenant_id, id)
);
COMMENT ON COLUMN human_questions.body_enc IS '@pii contact encrypted question (facts, preview of the draft)';
COMMENT ON COLUMN human_questions.content_digest IS '@pii contact digest of the content the question is about';
CREATE INDEX human_questions_open ON human_questions (tenant_id, status, next_escalation_at) WHERE status = 'open';
CREATE UNIQUE INDEX human_questions_one_open ON human_questions (tenant_id, kind, subject_ref) WHERE status = 'open';
CREATE TRIGGER human_questions_touch BEFORE UPDATE ON human_questions FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('human_questions', 'SELECT, INSERT');
GRANT UPDATE (assigned_user_id, escalation_level, next_escalation_at, reply_due_at, clarifications, status, closed_reason) ON human_questions TO sevari_app;

-- Every human input (§30.1). Rejected inputs are recorded too: nothing a human says is lost.
CREATE TABLE human_inputs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  region           region_code NOT NULL,
  question_id      uuid NOT NULL,
  kind             text NOT NULL,
  response         text NOT NULL,
  detail_enc       bytea,
  response_digest  bytea NOT NULL,
  responder_id     uuid NOT NULL,
  responder_role   text NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('app', 'email', 'sms', 'api')),
  received_at      timestamptz NOT NULL,
  decision_ms      integer,
  rubber_stamp     boolean NOT NULL DEFAULT false,
  status           text NOT NULL CHECK (status IN ('rejected', 'pending_effect', 'applied', 'failed', 'recorded')),
  rejection_reason text,
  consumed_by      text,
  effect_receipt_id uuid,
  effect_due_at    timestamptz,
  alerted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
  CHECK (status NOT IN ('pending_effect', 'applied', 'failed') OR consumed_by IS NOT NULL),
  CHECK (status <> 'applied' OR effect_receipt_id IS NOT NULL),
  FOREIGN KEY (tenant_id, question_id) REFERENCES human_questions (tenant_id, id),
  FOREIGN KEY (tenant_id, responder_id) REFERENCES users (tenant_id, id)
);
COMMENT ON COLUMN human_inputs.detail_enc IS '@pii contact encrypted detail (edited text, free-text answer)';
CREATE INDEX human_inputs_pending ON human_inputs (tenant_id, status, effect_due_at) WHERE status = 'pending_effect';
CREATE TRIGGER human_inputs_touch BEFORE UPDATE ON human_inputs FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('human_inputs', 'SELECT, INSERT');
GRANT UPDATE (status, consumed_by, effect_receipt_id, alerted_at, rejection_reason) ON human_inputs TO sevari_app;

-- Effect receipts (INV-13): the exact change a human input caused.
CREATE TABLE effect_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  input_id    uuid NOT NULL,
  effect_kind text NOT NULL,
  effect_ref  text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('done', 'failed')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, input_id),
  FOREIGN KEY (tenant_id, input_id) REFERENCES human_inputs (tenant_id, id)
);
COMMENT ON COLUMN effect_receipts.detail IS 'codes and references only; never message content';
SELECT sevari_meta.apply_tenant_rls('effect_receipts', 'SELECT, INSERT');

-- Notifications to humans (§74): questions, acknowledgements, outcomes, escalations, alerts.
-- The owner app inbox reads these; other channels deliver them through providers when enabled (§86).
CREATE TABLE human_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('question', 'ack', 'outcome', 'failure', 'escalation', 'alert', 'warning', 'info')),
  ref         text NOT NULL,
  dedupe_key  text NOT NULL,
  body_enc    bytea NOT NULL,
  channel     text NOT NULL DEFAULT 'app' CHECK (channel IN ('app', 'email', 'sms', 'push')),
  status      text NOT NULL DEFAULT 'delivered' CHECK (status IN ('queued', 'delivered', 'read')),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
COMMENT ON COLUMN human_notifications.body_enc IS '@pii contact encrypted notification text';
CREATE INDEX human_notifications_inbox ON human_notifications (tenant_id, user_id, created_at);
CREATE TRIGGER human_notifications_touch BEFORE UPDATE ON human_notifications FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('human_notifications', 'SELECT, INSERT');
GRANT UPDATE (status, read_at) ON human_notifications TO sevari_app;

-- Owner settings that change behaviour (§74.4 holding update, §81 go-live). Typed, not free-form config.
ALTER TABLE tenants ADD COLUMN holding_update_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN reply_due_minutes integer NOT NULL DEFAULT 120 CHECK (reply_due_minutes BETWEEN 5 AND 10080);

-- Platform decisions (§82 platform scope): made only with an operator credential. No tenant data:
-- references and reason codes only. Append-only for the app role.
CREATE TABLE platform_decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  decision    text NOT NULL,
  subject_ref text NOT NULL,
  reason      text NOT NULL,
  approver_role text NOT NULL CHECK (approver_role IN ('founder', 'operator', 'counsel')),
  -- Sign-offs (§71): what they cover and when they lapse.
  scope       text,
  expires_on  date,
  CHECK (decision <> 'signoff' OR (scope IS NOT NULL AND expires_on IS NOT NULL)),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1
);
ALTER TABLE platform_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_decisions_app ON platform_decisions FOR ALL TO sevari_app USING (true) WITH CHECK (true);
CREATE POLICY platform_decisions_admin ON platform_decisions FOR ALL TO sevari_owner USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform_decisions TO sevari_app;
