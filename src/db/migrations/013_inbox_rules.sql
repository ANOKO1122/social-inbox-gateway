-- Configuration and dry-run support only; no webhook automation is enabled.
CREATE TABLE inbox_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN ('moderation', 'reply')),
  platform text NOT NULL DEFAULT 'all' CHECK (platform IN ('all', 'facebook', 'instagram')),
  channel_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(channel_ids) <= 200),
  match_mode text NOT NULL DEFAULT 'any' CHECK (match_mode IN ('any', 'all')),
  keywords text[] NOT NULL CHECK (cardinality(keywords) BETWEEN 1 AND 100),
  exclusions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(exclusions) <= 100),
  word_boundary boolean NOT NULL DEFAULT false,
  ai_enabled boolean NOT NULL DEFAULT false,
  ai_instruction text NOT NULL DEFAULT '' CHECK (char_length(ai_instruction) <= 4000),
  action text NOT NULL DEFAULT 'review' CHECK (action IN ('hide', 'review', 'reply')),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'observe')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((category = 'reply' AND action = 'reply' AND ai_enabled) OR
         (category = 'moderation' AND action IN ('hide', 'review')))
);
