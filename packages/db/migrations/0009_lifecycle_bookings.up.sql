-- 0009 lifecycle engine and bookings (Part B §16, §16.1, Phase 9).
-- A journey (lifecycle subject) is a typed state machine whose states, transitions, guards, timers and
-- action classes are DATA (config/lifecycles/*.yaml). The database keeps where each subject is, every
-- transition (append-only, idempotent), and the timers. Bookings are real here: a slot can never be
-- double-booked (the database refuses overlaps), and a booking only becomes real when its confirmation
-- is authorised (a human approval, or an earned grant) (§7, §24).

-- btree_gist lets one exclusion constraint say "same business, same resource, overlapping time".
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- One house tenant (Veylith itself, Lifecycle V) per cell (§16).
CREATE UNIQUE INDEX tenants_one_house_per_region ON tenants (region) WHERE is_house;

------------------------------------------------------------------------------------------------
-- Journeys
------------------------------------------------------------------------------------------------
CREATE TABLE lifecycle_subjects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  region             region_code NOT NULL,
  lifecycle          text NOT NULL CHECK (lifecycle ~ '^[a-z][a-z0-9_]*$'),
  definition_version integer NOT NULL CHECK (definition_version > 0),
  definition_hash    text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  subject_type       text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]*$'),
  -- The person the journey is about. Erasing them deletes the journey with them.
  contact_id         uuid NOT NULL,
  state              text NOT NULL,
  -- Increments on every transition; a timer only fires if the subject is still at the seq it was set at.
  state_seq          integer NOT NULL DEFAULT 1 CHECK (state_seq > 0),
  state_entered_at   timestamptz NOT NULL,
  -- Named times and ids a timer or effect can refer to (e.g. booking_end, booking_id). No personal data.
  anchors            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON COLUMN lifecycle_subjects.anchors IS 'times and record ids only; never message content or contact details';
CREATE UNIQUE INDEX lifecycle_subjects_one_per_contact ON lifecycle_subjects (tenant_id, lifecycle, contact_id);
CREATE TRIGGER lifecycle_subjects_touch BEFORE UPDATE ON lifecycle_subjects FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('lifecycle_subjects', 'SELECT, INSERT');
GRANT UPDATE (state, state_seq, state_entered_at, anchors, definition_version, definition_hash) ON lifecycle_subjects TO sevari_app;

-- Every transition, append-only. (subject, idempotency_key) makes a replayed event one transition;
-- (subject, seq) makes two racing events produce exactly one winner per step.
CREATE TABLE lifecycle_transitions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  region             region_code NOT NULL,
  subject_id         uuid NOT NULL,
  seq                integer NOT NULL CHECK (seq > 0),
  from_state         text,
  to_state           text NOT NULL,
  event              text NOT NULL,
  action_class       text,
  authority          text NOT NULL CHECK (authority IN ('system', 'automatic', 'grant', 'approval', 'human')),
  authority_ref      text,
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  actor              text NOT NULL,
  definition_version integer NOT NULL,
  definition_hash    text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subject_id, idempotency_key),
  UNIQUE (tenant_id, subject_id, seq),
  -- A transition that sends, books or moves money names the authority behind it (§16, §7).
  CHECK (action_class IS NULL OR authority IN ('automatic', 'grant', 'approval', 'human')),
  CHECK (authority IN ('system', 'automatic') OR authority_ref IS NOT NULL),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES lifecycle_subjects (tenant_id, id) ON DELETE CASCADE
);
SELECT sevari_meta.apply_tenant_rls('lifecycle_transitions', 'SELECT, INSERT');

CREATE TABLE lifecycle_timers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  region      region_code NOT NULL,
  subject_id  uuid NOT NULL,
  state_seq   integer NOT NULL,
  event       text NOT NULL,
  fires_at    timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled', 'stale')),
  settled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subject_id, state_seq, event),
  CHECK ((status = 'pending') = (settled_at IS NULL)),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES lifecycle_subjects (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX lifecycle_timers_pending ON lifecycle_timers (tenant_id, subject_id) WHERE status = 'pending';
CREATE TRIGGER lifecycle_timers_touch BEFORE UPDATE ON lifecycle_timers FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('lifecycle_timers', 'SELECT, INSERT');
GRANT UPDATE (status, settled_at) ON lifecycle_timers TO sevari_app;

-- Human steps a journey asks for (§16.1: "a stage with nothing automatable still exists, as a human task").
ALTER TABLE human_questions DROP CONSTRAINT human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release', 'lifecycle_step'));

------------------------------------------------------------------------------------------------
-- Bookings
------------------------------------------------------------------------------------------------
-- The appointment windows offered to a customer in a reply. A later message choosing one is matched
-- against these, deterministically; nothing else can become a booking.
CREATE TABLE booking_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  region           region_code NOT NULL,
  contact_id       uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  enquiry_id       uuid,
  draft_id         uuid,
  service          text,
  windows          jsonb NOT NULL CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) > 0),
  reschedule_of    uuid,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'taken', 'expired', 'withdrawn')),
  offered_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (expires_at > offered_at),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, enquiry_id) REFERENCES enquiries (tenant_id, id) ON DELETE SET NULL (enquiry_id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES drafts (tenant_id, id) ON DELETE SET NULL (draft_id)
);
COMMENT ON COLUMN booking_offers.windows IS 'appointment times offered (times only; no personal data)';
CREATE INDEX booking_offers_open ON booking_offers (tenant_id, conversation_id, status);
CREATE TRIGGER booking_offers_touch BEFORE UPDATE ON booking_offers FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
SELECT sevari_meta.apply_tenant_rls('booking_offers', 'SELECT, INSERT');
GRANT UPDATE (status, draft_id) ON booking_offers TO sevari_app;

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  region           region_code NOT NULL,
  contact_id       uuid NOT NULL,
  conversation_id  uuid,
  enquiry_id       uuid,
  offer_id         uuid,
  -- Who or what is booked: one engineer, van or chair. Two bookings of one resource never overlap.
  resource         text NOT NULL DEFAULT 'default' CHECK (length(resource) BETWEEN 1 AND 64),
  service          text,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL CHECK (status IN ('held', 'confirmed', 'released', 'cancelled', 'completed', 'no_show', 'rescheduled')),
  -- A hold is the slot kept while its confirmation waits for approval; it lapses at this time.
  hold_expires_at  timestamptz,
  draft_id         uuid,
  -- The customer asked to cancel: this cancellation message, once authorised, cancels the booking.
  cancel_draft_id  uuid,
  replaces_id      uuid,
  confirmed_at     timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  CHECK (status NOT IN ('confirmed', 'completed', 'no_show') OR confirmed_at IS NOT NULL),
  -- The rule that matters: no double booking, enforced by the database for every writer.
  EXCLUDE USING gist (tenant_id WITH =, resource WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('held', 'confirmed')),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (tenant_id, enquiry_id) REFERENCES enquiries (tenant_id, id) ON DELETE SET NULL (enquiry_id),
  FOREIGN KEY (tenant_id, offer_id) REFERENCES booking_offers (tenant_id, id) ON DELETE SET NULL (offer_id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES drafts (tenant_id, id) ON DELETE SET NULL (draft_id),
  FOREIGN KEY (tenant_id, cancel_draft_id) REFERENCES drafts (tenant_id, id) ON DELETE SET NULL (cancel_draft_id),
  FOREIGN KEY (tenant_id, replaces_id) REFERENCES bookings (tenant_id, id) ON DELETE SET NULL (replaces_id)
);
CREATE INDEX bookings_contact ON bookings (tenant_id, contact_id, status, starts_at);
CREATE INDEX bookings_busy ON bookings (tenant_id, status, starts_at) WHERE status IN ('held', 'confirmed');
CREATE TRIGGER bookings_touch BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION sevari_meta.touch();
-- The slot itself never moves: a change is a new booking that replaces the old one (history kept).
CREATE FUNCTION sevari_meta.bookings_slot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.resource <> OLD.resource OR NEW.contact_id <> OLD.contact_id THEN
    RAISE EXCEPTION 'a booking''s time, resource and customer cannot change; make a new booking that replaces it' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('released', 'cancelled', 'completed', 'no_show', 'rescheduled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'booking % is closed (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_slot_immutable BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION sevari_meta.bookings_slot_immutable();
SELECT sevari_meta.apply_tenant_rls('bookings', 'SELECT, INSERT');
GRANT UPDATE (status, hold_expires_at, draft_id, cancel_draft_id, confirmed_at, closed_at) ON bookings TO sevari_app;
