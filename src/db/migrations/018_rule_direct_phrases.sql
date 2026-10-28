-- Full-comment exact matches can bypass AI during previews; no automatic execution.
ALTER TABLE inbox_rules ADD COLUMN direct_phrases text[] NOT NULL DEFAULT '{}';
ALTER TABLE inbox_rules ADD COLUMN direct_action text NOT NULL DEFAULT 'hide'
  CHECK (direct_action IN ('hide', 'review'));

ALTER TABLE inbox_rules ADD CONSTRAINT inbox_rules_direct_phrases_valid
  CHECK (cardinality(direct_phrases) <= 100
    AND array_position(direct_phrases, NULL) IS NULL
    AND (category = 'moderation' OR cardinality(direct_phrases) = 0));
