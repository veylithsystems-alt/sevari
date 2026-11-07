DROP TABLE IF EXISTS accounting_sync_log;
DROP TABLE IF EXISTS accounting_mappings;
DROP TABLE IF EXISTS accounting_connections;
CREATE OR REPLACE FUNCTION sevari_meta.tenants_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('active', 'shadow') THEN
    IF NOT EXISTS (SELECT 1 FROM tenant_activations a WHERE a.tenant_id = NEW.id AND a.mode = NEW.status AND a.txid = txid_current()
                     AND (NOT NEW.regulated OR a.platform_decision_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'business % can only go % with a recorded go-live decision (§18, §81)', NEW.id, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.regulated AND NOT NEW.regulated AND current_user <> 'sevari_owner' THEN
    RAISE EXCEPTION 'a regulated-activity finding can only be cleared by Veylith' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE IF EXISTS billing_runs;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS plans;
