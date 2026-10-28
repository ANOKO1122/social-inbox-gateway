-- Eligible rules at ingestion are not necessarily matched rules. Preserve the
-- existing primary-rule attribution for old rows without inventing matches.
ALTER TABLE rule_runs ADD COLUMN matched_rule_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX rule_runs_matched_rules_idx ON rule_runs USING gin(matched_rule_ids)
  WHERE status = 'completed';
CREATE INDEX rule_runs_legacy_rule_idx ON rule_runs(rule_id, processed_at DESC)
  WHERE status = 'completed' AND cardinality(matched_rule_ids) = 0;

COMMENT ON COLUMN rule_runs.matched_rule_ids IS
  'Rules actually matched during processing, retained as IDs even if a rule is later deleted. Empty on legacy runs; use rule_id only for historical attribution.';
