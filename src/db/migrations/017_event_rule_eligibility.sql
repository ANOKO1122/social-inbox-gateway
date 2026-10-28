-- All existing normalized events are historical for rule execution, even when their
-- original webhook was genuine. New external/older writers default to ineligible.
ALTER TABLE normalized_events
  ADD COLUMN ingest_source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN rule_eligible boolean NOT NULL DEFAULT false;

ALTER TABLE normalized_events ALTER COLUMN ingest_source SET DEFAULT 'external';

ALTER TABLE normalized_events
  ADD CONSTRAINT normalized_events_ingest_source_valid
    CHECK (ingest_source IN ('meta_webhook', 'api_pull', 'external', 'legacy')),
  ADD CONSTRAINT normalized_events_rule_eligible_valid
    CHECK (NOT rule_eligible OR (ingest_source = 'meta_webhook' AND kind = 'comment'));

COMMENT ON COLUMN normalized_events.ingest_source IS
  'Record origin, assigned only on insertion. Repeated webhooks must not upgrade historical or imported comments.';
COMMENT ON COLUMN normalized_events.rule_eligible IS
  'Origin eligibility only, not an execution queue. Future rules may consume newly received eligible events after activation; never scan old eligible rows for backfill.';
