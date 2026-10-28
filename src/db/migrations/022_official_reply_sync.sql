-- Outbound callbacks never enter normalized_events, customer counts or rule queues.
CREATE TABLE official_replies (
  platform text NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  kind text NOT NULL CHECK (kind IN ('comment', 'message')),
  channel_id text NOT NULL,
  external_id text NOT NULL,
  recipient_id text,
  parent_id text,
  post_id text,
  body text,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (platform, kind, channel_id, external_id),
  CHECK (kind <> 'message' OR recipient_id IS NOT NULL)
);
CREATE INDEX official_replies_parent_idx ON official_replies(platform, channel_id, parent_id) WHERE kind = 'comment';
CREATE INDEX official_replies_post_idx ON official_replies(platform, channel_id, post_id) WHERE kind = 'comment';
CREATE INDEX official_replies_recipient_idx ON official_replies(platform, channel_id, recipient_id, occurred_at) WHERE kind = 'message';

-- Keep tombstones even if removal arrives before the original add callback.
CREATE TABLE comment_revisions (
  platform text NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  channel_id text NOT NULL,
  external_id text NOT NULL,
  body text,
  deleted boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (platform, channel_id, external_id)
);
