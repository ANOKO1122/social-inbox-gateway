import type { MetaOauthClient } from './oauth-client.js';
import { PAGE_SUBSCRIBED_FIELDS } from './oauth-client.js';

const OBJECT_ID = /^[0-9]{5,32}$/;
const SCOPE = /^[a-z_]{1,64}$/;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

export interface SaveChannel {
  kind: 'facebook_page' | 'instagram';
  externalId: string;
  name: string;
  pageId: string;
  accessToken: string;
  subscribed: boolean;
  subscriptionError: string | null;
}

export interface SaveAuthorization {
  facebookUserId: string;
  userToken: string;
  userTokenExpiresAt: Date;
  scopes: string[];
  channels: SaveChannel[];
}

export interface ChannelSummary {
  kind: 'facebook_page' | 'instagram';
  externalId: string;
  name: string;
  pageId: string;
  subscribed: boolean;
  subscriptionError: string | null;
}

export interface GrantSummary {
  facebookUserId: string;
  expiresAt: Date;
  scopes: string[];
}

export interface ConnectSummary {
  grants: GrantSummary[];
  channels: ChannelSummary[];
}

export interface AuthorizationStore {
  save(input: SaveAuthorization): Promise<void>;
  summary(): Promise<ConnectSummary>;
}

export async function completeAuthorization(
  oauth: MetaOauthClient,
  channels: AuthorizationStore,
  code: string,
  now: Date = new Date(),
): Promise<string> {
  const shortToken = await oauth.exchangeCode(code);
  const longLived = await oauth.exchangeLongLived(shortToken);
  const facebookUserId = await oauth.fetchUserId(longLived.accessToken);
  const scopes = (await oauth.fetchGrantedScopes(longLived.accessToken)).filter((scope) => SCOPE.test(scope));
  const pages = await oauth.listPages(longLived.accessToken);
  const savedChannels: SaveChannel[] = [];

  for (const page of pages) {
    if (!OBJECT_ID.test(page.id)) {
      continue;
    }
    const subscription = await oauth.subscribePage(page.id, page.accessToken);
    const subscriptionError = subscription.ok
      ? null
      : (SAFE_CODE.test(subscription.code) ? subscription.code : 'graph_error');
    savedChannels.push({
      kind: 'facebook_page',
      externalId: page.id,
      name: page.name,
      pageId: page.id,
      accessToken: page.accessToken,
      subscribed: subscription.ok,
      subscriptionError,
    });

    if (page.instagram && OBJECT_ID.test(page.instagram.id)) {
      savedChannels.push({
        kind: 'instagram',
        externalId: page.instagram.id,
        name: page.instagram.username,
        pageId: page.id,
        accessToken: page.accessToken,
        subscribed: subscription.ok,
        subscriptionError,
      });
    }
  }

  await channels.save({
    facebookUserId,
    userToken: longLived.accessToken,
    userTokenExpiresAt: new Date(now.getTime() + longLived.expiresIn * 1000),
    scopes,
    channels: savedChannels,
  });
  return facebookUserId;
}

export { PAGE_SUBSCRIBED_FIELDS };
