DROP TRIGGER IF EXISTS job_queue_notify ON job_queue;
DROP FUNCTION IF EXISTS sevari_meta.job_queue_notify();
DROP TABLE IF EXISTS reply_records;
DROP TABLE IF EXISTS outbox;
DROP FUNCTION IF EXISTS sevari_meta.outbox_content_immutable();
DROP TABLE IF EXISTS suppressions;
