-- Shared plain-text replies for the staff workbench. Disabled entries remain editable.
CREATE TABLE saved_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  platform text NOT NULL DEFAULT 'all' CHECK (platform IN ('all', 'facebook', 'instagram')),
  kind text NOT NULL DEFAULT 'all' CHECK (kind IN ('all', 'comment', 'message')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saved_replies_enabled_updated_idx ON saved_replies (enabled, updated_at DESC, id);
