-- Staff accounts, page assignments, and reply audit snapshots.
-- Audit rows are kept permanently. They do not reference Facebook objects with ON DELETE CASCADE.

CREATE TABLE staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dingtalk_union_id text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_users_union_id_key UNIQUE (dingtalk_union_id),
  CONSTRAINT staff_users_union_id_check CHECK (dingtalk_union_id ~ '^[A-Za-z0-9_-]{4,128}$'),
  CONSTRAINT staff_users_name_check CHECK (char_length(display_name) BETWEEN 1 AND 80),
  CONSTRAINT staff_users_role_check CHECK (role IN ('admin', 'agent'))
);

CREATE TABLE staff_page_access (
  staff_user_id uuid NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  page_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_user_id, page_id),
  CONSTRAINT staff_page_access_page_id_check CHECK (page_id ~ '^[0-9]{5,32}$')
);

ALTER TABLE meta_user_grants
  ADD COLUMN authorized_by uuid REFERENCES staff_users (id);

CREATE TABLE reply_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_users (id),
  staff_union_id text NOT NULL,
  staff_name text NOT NULL,
  normalized_event_id uuid NOT NULL,
  platform text NOT NULL,
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  external_id text NOT NULL,
  sender_id text NOT NULL,
  comment_body text,
  reply_body text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  platform_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_audit_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT reply_audit_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT reply_audit_reply_body_check CHECK (char_length(reply_body) BETWEEN 1 AND 8000),
  CONSTRAINT reply_audit_error_code_check CHECK (
    error_code IS NULL OR error_code ~ '^[A-Za-z0-9_]{1,64}$'
  )
);

CREATE INDEX reply_audit_created_at_idx ON reply_audit (created_at DESC);
CREATE INDEX reply_audit_event_idx ON reply_audit (normalized_event_id, created_at DESC);
CREATE INDEX normalized_events_facebook_comments_idx
  ON normalized_events (occurred_at DESC, id DESC)
  WHERE platform = 'facebook' AND kind = 'comment';
