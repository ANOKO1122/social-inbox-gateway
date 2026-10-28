CREATE TABLE comment_visibility (
  platform text NOT NULL, channel_id text NOT NULL, external_id text NOT NULL,
  hidden boolean NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(platform, channel_id, external_id)
);
CREATE TABLE comment_moderation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_event_id uuid NOT NULL, staff_user_id uuid NOT NULL REFERENCES staff_users(id),
  staff_name text NOT NULL, platform text NOT NULL, channel_id text NOT NULL,
  channel_name text NOT NULL, external_id text NOT NULL, comment_body text NOT NULL,
  hidden boolean NOT NULL, status text NOT NULL CHECK(status IN ('sent','failed')),
  error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_moderation_audit_created_idx ON comment_moderation_audit(created_at DESC);
