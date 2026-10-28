-- Enabling a rule only admits new verified webhook comments. This migration
-- deliberately does not enqueue or enable any existing rule or comment.
ALTER TABLE inbox_rules
  ADD COLUMN enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN enabled_at timestamptz,
  ADD CONSTRAINT inbox_rules_execution_valid
    CHECK (NOT enabled OR (category = 'moderation' AND enabled_at IS NOT NULL));

CREATE TABLE rule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_event_id uuid NOT NULL UNIQUE REFERENCES normalized_events(id),
  rule_ids uuid[] NOT NULL CHECK (cardinality(rule_ids) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  decision text CHECK (decision IN ('hide', 'keep', 'review', 'skip')),
  outcome text CHECK (outcome IN ('hidden', 'already_hidden', 'kept', 'review', 'skipped', 'failed')),
  rule_id uuid REFERENCES inbox_rules(id) ON DELETE SET NULL,
  rule_name text,
  reason text NOT NULL DEFAULT '',
  matched_keywords text[] NOT NULL DEFAULT '{}',
  visibility_before boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  claim_token uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  -- Persist before a Graph mutation. An interrupted mutation is inspected on
  -- recovery, never blindly sent a second time.
  write_started_at timestamptz,
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'dismissed', 'resolved')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES staff_users(id)
);

CREATE INDEX rule_runs_pending_idx ON rule_runs(created_at, id) WHERE status = 'pending';
CREATE INDEX rule_runs_processing_idx ON rule_runs(claimed_at) WHERE status = 'processing';
CREATE INDEX rule_runs_review_idx ON rule_runs(processed_at DESC)
  WHERE status = 'completed' AND decision = 'review' AND review_status = 'open';
CREATE INDEX rule_runs_processed_idx ON rule_runs(processed_at DESC) WHERE status = 'completed';

COMMENT ON TABLE rule_runs IS
  'Durable moderation queue, inserted in the verified webhook transaction only for brand-new comments while moderation rules are enabled. Historical comments are never backfilled.';
