CREATE TABLE inbox_ad_referrals (
  platform text NOT NULL,
  channel_id text NOT NULL,
  sender_id text NOT NULL,
  ad_id text,
  PRIMARY KEY (platform, channel_id, sender_id)
);

-- Includes standalone messaging_referrals, message.referral and postback.referral.
CREATE FUNCTION capture_inbox_ad_referrals(payload jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO inbox_ad_referrals(platform, channel_id, sender_id, ad_id)
  SELECT DISTINCT ON (e->>'id', m->'sender'->>'id')
    CASE payload->>'object' WHEN 'instagram' THEN 'instagram' ELSE 'facebook' END,
    e->>'id', m->'sender'->>'id', nullif(r->>'ad_id','')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'entry')='array' THEN payload->'entry' ELSE '[]'::jsonb END) e
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'messaging')='array' THEN e->'messaging' ELSE '[]'::jsonb END) m
  CROSS JOIN LATERAL (VALUES (m->'referral'),(m->'message'->'referral'),(m->'postback'->'referral')) refs(r)
  WHERE payload->>'object' IN ('page','instagram')
    AND e->>'id' ~ '^[0-9]{5,32}$' AND m->'sender'->>'id' ~ '^[0-9]{5,32}$'
    AND m->'sender'->>'id' <> e->>'id'
    AND m->'recipient'->>'id' = e->>'id'
    AND (upper(r->>'source')='ADS' OR nullif(r->>'ad_id','') IS NOT NULL)
  ORDER BY e->>'id',m->'sender'->>'id',r->>'ad_id' NULLS LAST
  ON CONFLICT(platform,channel_id,sender_id) DO UPDATE SET ad_id=coalesce(EXCLUDED.ad_id,inbox_ad_referrals.ad_id);
$$;
CREATE FUNCTION inbox_ad_referral_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM capture_inbox_ad_referrals(NEW.raw_payload);
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_ad_referral_ingest AFTER INSERT ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION inbox_ad_referral_trigger();
SELECT capture_inbox_ad_referrals(raw_payload) FROM webhook_events;
