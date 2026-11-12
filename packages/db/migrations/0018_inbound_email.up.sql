-- 0018 inbound email through Brevo (approved provider, §29): each email channel gets its own receiving
-- address on the cell's receiving domain, e.g. pats-drains-4k2m9q@in.example. Brevo receives the email and
-- posts it to the cell; the address says which business it is for. The address is the business's, not a
-- person's, so it is not personal data.
ALTER TABLE channel_endpoints ADD COLUMN inbound_address text UNIQUE
  CHECK (inbound_address IS NULL OR inbound_address ~ '^[a-z0-9][a-z0-9-]{2,62}@[a-z0-9][a-z0-9.-]{1,200}$');
-- Found by its address before the business is known, the same way an endpoint is found by its public id.
CREATE POLICY endpoint_by_inbound_address ON channel_endpoints FOR SELECT TO sevari_app
  USING (inbound_address = nullif(current_setting('app.inbound_address', true), ''));
