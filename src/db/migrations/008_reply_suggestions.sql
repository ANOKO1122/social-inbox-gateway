-- Drafts returned by Dify. The final sent text stays in reply_audit.
-- adopted_at means this draft was on screen when that staff member sent.

CREATE TABLE reply_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_event_id uuid NOT NULL,
  staff_user_id uuid NOT NULL REFERENCES staff_users (id),
  intent text NOT NULL,
  suggested_reply text NOT NULL,
  needs_human boolean NOT NULL,
  sources jsonb NOT NULL,
  adopted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_suggestions_intent_check CHECK (intent ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT reply_suggestions_reply_check CHECK (char_length(suggested_reply) BETWEEN 1 AND 8000),
  CONSTRAINT reply_suggestions_sources_check CHECK (jsonb_typeof(sources) = 'array')
);

CREATE INDEX reply_suggestions_event_idx
  ON reply_suggestions (normalized_event_id, created_at DESC);
