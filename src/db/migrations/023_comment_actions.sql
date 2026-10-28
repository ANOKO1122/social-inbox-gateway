CREATE TABLE comment_actions (
  platform text NOT NULL CHECK (platform IN ('facebook','instagram')),
  channel_id text NOT NULL,
  external_id text NOT NULL,
  liked boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, channel_id, external_id)
);
CREATE TABLE inbox_blocked_users (
  platform text NOT NULL CHECK (platform IN ('facebook','instagram')),
  channel_id text NOT NULL,
  sender_id text NOT NULL,
  blocked boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, channel_id, sender_id)
);
CREATE TABLE comment_action_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_event_id uuid NOT NULL REFERENCES normalized_events(id),
  staff_user_id uuid NOT NULL REFERENCES staff_users(id),
  staff_name text NOT NULL, platform text NOT NULL, channel_id text NOT NULL,
  channel_name text NOT NULL, external_id text NOT NULL, sender_id text NOT NULL,
  comment_body text NOT NULL, post_id text,
  action text NOT NULL CHECK (action IN ('like','unlike','delete','block','unblock')),
  status text NOT NULL CHECK (status IN ('sent','failed')), error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_action_audit_staff_created_idx ON comment_action_audit(staff_user_id,created_at DESC);
CREATE INDEX comment_action_audit_created_idx ON comment_action_audit(created_at DESC);
CREATE INDEX normalized_message_sender_idx ON normalized_events(platform,channel_id,sender_id) WHERE kind='message';
