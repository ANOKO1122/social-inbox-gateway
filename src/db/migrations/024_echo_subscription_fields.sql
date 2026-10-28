-- Store the verified subscription field set without depending on field order.
ALTER TABLE meta_channels DROP CONSTRAINT meta_channels_subscribed_fields_check;
ALTER TABLE meta_channels ADD CONSTRAINT meta_channels_subscribed_fields_check CHECK (
  subscribed_fields IS NULL OR (subscribed_fields <> '' AND string_to_array(subscribed_fields, ',')
    <@ ARRAY['feed','messages','message_echoes','messaging_referrals','messaging_postbacks']::text[])
);
