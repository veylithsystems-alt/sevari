-- Run once per database as a superuser (cluster bootstrap / provisioning job).
-- Creates the two roles the contract requires (§6.1):
--   sevari_owner: owns schema objects, runs migrations. Subject to RLS via FORCE.
--   sevari_app:   the application role. NOBYPASSRLS, not an owner, least privilege per table.
--   sevari_worker: claims jobs from the queue across tenants (ids only); does all real work as sevari_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sevari_owner') THEN
    CREATE ROLE sevari_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sevari_worker') THEN
    CREATE ROLE sevari_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sevari_app') THEN
    CREATE ROLE sevari_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
  END IF;
END $$;
ALTER ROLE sevari_owner NOSUPERUSER NOBYPASSRLS;
ALTER ROLE sevari_app NOSUPERUSER NOBYPASSRLS NOINHERIT;
ALTER ROLE sevari_worker NOSUPERUSER NOBYPASSRLS NOINHERIT;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO sevari_owner;
GRANT USAGE ON SCHEMA public TO sevari_app;
