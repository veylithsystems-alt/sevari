DROP TABLE IF EXISTS bookings;
DROP FUNCTION IF EXISTS sevari_meta.bookings_slot_immutable();
DROP TABLE IF EXISTS booking_offers;
ALTER TABLE human_questions DROP CONSTRAINT IF EXISTS human_questions_kind_check;
ALTER TABLE human_questions ADD CONSTRAINT human_questions_kind_check
  CHECK (kind IN ('approve_draft', 'clarify_edit', 'owner_task', 'autonomy_grant', 'knowledge_update', 'dsar_release'));
DROP TABLE IF EXISTS lifecycle_timers;
DROP TABLE IF EXISTS lifecycle_transitions;
DROP TABLE IF EXISTS lifecycle_subjects;
DROP INDEX IF EXISTS tenants_one_house_per_region;
