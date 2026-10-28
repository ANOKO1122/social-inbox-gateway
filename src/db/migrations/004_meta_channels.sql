-- Facebook user grants and the page tokens used for replies and webhook subscription.
-- Tokens are ciphertext produced by the application. This file never sees plaintext.

CREATE TABLE meta_user_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facebook_user_id text NOT NULL,
  encrypted_user_token text NOT NULL,
  user_token_expires_at timestamptz NOT NULL,
  scopes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_user_grants_facebook_user_id_key UNIQUE (facebook_user_id),
  CONSTRAINT meta_user_grants_facebook_user_id_check CHECK (facebook_user_id ~ '^[0-9]{5,32}$'),
  CONSTRAINT meta_user_grants_token_check CHECK (char_length(encrypted_user_token) > 0),
  CONSTRAINT meta_user_grants_scopes_check CHECK (
    scopes = '' OR scopes ~ '^[a-z_]{1,64}(,[a-z_]{1,64})*$'
  )
);

CREATE TABLE meta_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES meta_user_grants (id) ON DELETE CASCADE,
  kind text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  page_id text NOT NULL,
  encrypted_access_token text NOT NULL,
  subscribed_fields text,
  subscription_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_channels_kind_external_id_key UNIQUE (kind, external_id),
  CONSTRAINT meta_channels_kind_check CHECK (kind IN ('facebook_page', 'instagram')),
  CONSTRAINT meta_channels_external_id_check CHECK (external_id ~ '^[0-9]{5,32}$'),
  CONSTRAINT meta_channels_page_id_check CHECK (page_id ~ '^[0-9]{5,32}$'),
  CONSTRAINT meta_channels_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT meta_channels_token_check CHECK (char_length(encrypted_access_token) > 0),
  CONSTRAINT meta_channels_subscribed_fields_check CHECK (
    subscribed_fields IS NULL OR subscribed_fields = 'feed,messages'
  ),
  CONSTRAINT meta_channels_subscription_error_check CHECK (
    subscription_error IS NULL OR subscription_error ~ '^[a-z0-9_]{1,64}$'
  )
);

CREATE INDEX meta_channels_external_id_idx ON meta_channels (external_id);
CREATE INDEX meta_channels_grant_id_idx ON meta_channels (grant_id);
