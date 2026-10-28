-- OR between condition groups, AND between the keywords within each group.
-- Leave existing rows NULL: older application instances may still update keywords/match_mode
-- during rollout. The new reader derives equivalent groups until the rule is next saved.
-- This remains configuration/preview only.
ALTER TABLE inbox_rules ADD COLUMN keyword_groups jsonb;

ALTER TABLE inbox_rules ADD CONSTRAINT inbox_rules_keyword_groups_array
  CHECK (jsonb_typeof(keyword_groups) = 'array' AND jsonb_array_length(keyword_groups) BETWEEN 1 AND 100);
