-- Reverses 0001. Only for development and the T-MIG test; production uses expand-contract (§36.2).
-- Helper functions first: policies, triggers and functions depend on them and on the table row types.
DROP SCHEMA IF EXISTS sevari_meta CASCADE;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS audit_checkpoints;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS tenant_keys;
DROP TABLE IF EXISTS region_transfer_contracts;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS regions;
DROP DOMAIN IF EXISTS region_code;
