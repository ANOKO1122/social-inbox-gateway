-- Keep old rows unclassified: historical reports verify the receiver fingerprint.
-- Direct imports default to external; only the signed webhook receiver opts in.
ALTER TABLE webhook_events ADD COLUMN ingest_source text;
ALTER TABLE webhook_events ALTER COLUMN ingest_source SET DEFAULT 'external';
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_ingest_source_check
  CHECK (ingest_source IN ('meta_webhook', 'api_pull', 'external'));

CREATE INDEX webhook_events_received_at_id_idx ON webhook_events(received_at,id);
CREATE INDEX webhook_events_payload_lookup_idx ON webhook_events USING gin(raw_payload jsonb_path_ops);
CREATE INDEX reply_audit_sent_updated_idx ON reply_audit(updated_at) WHERE status='sent';
CREATE INDEX reply_audit_sent_message_idx ON reply_audit(platform_message_id) WHERE status='sent';
