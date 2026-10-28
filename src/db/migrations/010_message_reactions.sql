CREATE TABLE IF NOT EXISTS message_reactions (
  normalized_event_id uuid PRIMARY KEY REFERENCES normalized_events(id),
  reaction text NOT NULL,
  staff_user_id uuid REFERENCES staff_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
