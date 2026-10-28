CREATE TABLE outbound_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_event_id uuid NOT NULL REFERENCES normalized_events (id),
  idempotency_key text NOT NULL,
  status text NOT NULL,
  platform_message_id text,
  error_code text,
  error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_replies_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT outbound_replies_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT outbound_replies_error_code_check CHECK (
    error_code IS NULL OR error_code ~ '^[A-Za-z0-9_]{1,64}$'
  ),
  CONSTRAINT outbound_replies_error_type_check CHECK (
    error_type IS NULL OR error_type ~ '^[A-Za-z0-9_]{1,64}$'
  )
);

CREATE INDEX outbound_replies_normalized_event_id_idx ON outbound_replies (normalized_event_id);
