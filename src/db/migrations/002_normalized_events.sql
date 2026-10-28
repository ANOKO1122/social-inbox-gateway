CREATE TABLE normalized_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id uuid NOT NULL REFERENCES webhook_events (id),
  platform text NOT NULL,
  kind text NOT NULL,
  channel_id text NOT NULL,
  sender_id text NOT NULL,
  external_id text NOT NULL,
  parent_id text,
  body text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalized_events_platform_check CHECK (platform IN ('facebook', 'instagram')),
  CONSTRAINT normalized_events_kind_check CHECK (kind IN ('comment', 'message')),
  CONSTRAINT normalized_events_business_key UNIQUE (platform, kind, external_id)
);

CREATE INDEX normalized_events_webhook_event_id_idx ON normalized_events (webhook_event_id);
