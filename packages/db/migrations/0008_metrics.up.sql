-- 0008 metrics (§10.3, Phase 8): measurement views and stored owner reports.
-- Every view is security_invoker: it runs with the caller's rights, so row-level security on the
-- underlying tables applies and a business only ever measures itself (the boot check enforces this).

-- One row per enquiry: how fast it was acknowledged, drafted and answered, and what happened.
CREATE VIEW metrics_enquiry_flow WITH (security_invoker = true) AS
SELECT e.tenant_id, e.region, e.id AS enquiry_id, m.received_at, e.analysed_at, e.route, e.intent, e.intent_source, e.abstained,
       (SELECT min(o.sent_at) FROM outbox o
         WHERE o.tenant_id = e.tenant_id AND o.in_reply_to = e.message_id AND o.purpose IN ('ack', 'safety', 'holding') AND o.state = 'sent') AS ack_sent_at,
       (SELECT min(d.created_at) FROM drafts d WHERE d.tenant_id = e.tenant_id AND d.enquiry_id = e.id) AS first_draft_at,
       (SELECT min(o.sent_at) FROM drafts d JOIN outbox o ON o.tenant_id = d.tenant_id AND o.id = d.outbox_id
         WHERE d.tenant_id = e.tenant_id AND d.enquiry_id = e.id AND o.state = 'sent') AS reply_sent_at,
       EXISTS (SELECT 1 FROM drafts d WHERE d.tenant_id = e.tenant_id AND d.enquiry_id = e.id AND d.parent_id IS NOT NULL) AS edited,
       EXISTS (SELECT 1 FROM drafts d WHERE d.tenant_id = e.tenant_id AND d.enquiry_id = e.id AND d.status = 'rejected') AS rejected,
       EXISTS (SELECT 1 FROM drafts d WHERE d.tenant_id = e.tenant_id AND d.enquiry_id = e.id AND d.status = 'expired') AS expired
  FROM enquiries e JOIN messages m ON m.tenant_id = e.tenant_id AND m.id = e.message_id;

-- Every human decision, with how long it took to make (from being asked to answering).
CREATE VIEW metrics_decisions WITH (security_invoker = true) AS
SELECT i.tenant_id, i.region, i.received_at, q.kind, i.response, i.status, i.decision_ms, i.rubber_stamp, i.responder_role
  FROM human_inputs i JOIN human_questions q ON q.tenant_id = i.tenant_id AND q.id = i.question_id;

-- FLOOR (must be zero): a message other than an acknowledgement sent with neither a consumed human
-- approval nor an autonomy grant behind it (INV-4).
CREATE VIEW metrics_floor_unauthorised_sends WITH (security_invoker = true) AS
SELECT o.tenant_id, o.region, o.id AS outbox_id, o.sent_at
  FROM outbox o
 WHERE o.state = 'sent' AND o.action_class <> 'ack'
   AND NOT EXISTS (SELECT 1 FROM drafts d JOIN approvals a ON a.tenant_id = d.tenant_id AND a.draft_id = d.id AND a.consumed_at IS NOT NULL
                    WHERE d.tenant_id = o.tenant_id AND d.outbox_id = o.id)
   AND NOT EXISTS (SELECT 1 FROM reply_records r WHERE r.tenant_id = o.tenant_id AND r.outbox_id = o.id AND r.autonomy_decision LIKE 'grant:%');

-- FLOOR (must be zero): a message sent to someone who had opted out before it was sent.
CREATE VIEW metrics_floor_suppressed_sends WITH (security_invoker = true) AS
SELECT o.tenant_id, o.region, o.id AS outbox_id, o.sent_at
  FROM outbox o JOIN suppressions s ON s.tenant_id = o.tenant_id AND s.recipient_bidx = o.recipient_bidx AND s.channel_scope IN (o.channel, 'all')
 WHERE o.state = 'sent' AND s.created_at < o.sent_at;

-- What customers asked that the records couldn't answer (§5.4): the owner's to-do list for knowledge.
CREATE VIEW metrics_unknowns WITH (security_invoker = true) AS
SELECT e.tenant_id, e.region, e.analysed_at, f.missing
  FROM enquiries e CROSS JOIN LATERAL unnest(e.facts_missing) AS f(missing);

GRANT SELECT ON metrics_enquiry_flow, metrics_decisions, metrics_floor_unauthorised_sends, metrics_floor_suppressed_sends, metrics_unknowns TO sevari_app;

-- Owner reports (weekly, §8.1): the numbers (codes and counts only) and the rendered text (sealed).
CREATE TABLE owner_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  region       region_code NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('weekly')),
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  metrics      jsonb NOT NULL,
  body_enc     bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, period_start),
  CHECK (period_end > period_start)
);
COMMENT ON COLUMN owner_reports.metrics IS 'counts, rates and durations only; never message content';
COMMENT ON COLUMN owner_reports.body_enc IS '@pii contact the rendered report (may name what customers asked about)';
SELECT sevari_meta.apply_tenant_rls('owner_reports', 'SELECT, INSERT');
