-- Cached Facebook post text and nearby comments for the workbench.
-- The webhook only carries the post id. The post body is fetched from Graph.

CREATE TABLE comment_context (
  normalized_event_id uuid PRIMARY KEY REFERENCES normalized_events (id),
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
