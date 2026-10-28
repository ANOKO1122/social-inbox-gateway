-- NULL keeps existing rules and older writers compatible; readers use all three actions.
ALTER TABLE inbox_rules ADD COLUMN allowed_actions text[];

ALTER TABLE inbox_rules ADD CONSTRAINT inbox_rules_allowed_actions_valid
  CHECK (allowed_actions IS NULL OR (
    cardinality(allowed_actions) BETWEEN 1 AND 3
    AND array_position(allowed_actions, NULL) IS NULL
    AND allowed_actions <@ ARRAY['hide', 'keep', 'review']::text[]
    AND 'review' = ANY(allowed_actions)
  ));
