DROP POLICY IF EXISTS endpoint_by_inbound_address ON channel_endpoints;
ALTER TABLE channel_endpoints DROP COLUMN IF EXISTS inbound_address;
