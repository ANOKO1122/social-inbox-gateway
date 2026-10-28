ALTER TABLE comment_context ADD COLUMN IF NOT EXISTS post_id text;

CREATE INDEX IF NOT EXISTS comment_context_post_id_idx ON comment_context (post_id);
