-- Requires PostgreSQL 13+ (gen_random_uuid() is built in).
CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_object text NOT NULL,
  event_key text NOT NULL,
  raw_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_event_key_key UNIQUE (event_key)
);
