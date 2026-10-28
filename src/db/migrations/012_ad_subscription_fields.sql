ALTER TABLE meta_channels DROP CONSTRAINT meta_channels_subscribed_fields_check;
ALTER TABLE meta_channels ADD CONSTRAINT meta_channels_subscribed_fields_check
  CHECK (subscribed_fields IS NULL OR subscribed_fields IN ('feed,messages', 'feed,messages,messaging_referrals,messaging_postbacks'));
