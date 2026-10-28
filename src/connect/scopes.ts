/**
 * Baseline inbox permissions. Classic Instagram names match the
 * Facebook app already used by Postiz; the business_* renames are not configured there.
 * `business_management` is included because that app already needs it to list pages.
 */
export const REQUIRED_SCOPES = [
  'pages_show_list',
  'business_management',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'pages_messaging',
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
] as const;

// The dedicated buttons can request these scopes for their respective platform.
export const COMMENT_ACTION_SCOPES = { facebook: ['pages_read_user_content'], instagram: ['pages_read_user_content', 'instagram_manage_engagement'] } as const;

/** Ordinary login requests all supported operations; readiness remains base-only. */
export const LOGIN_SCOPES = [...REQUIRED_SCOPES, ...COMMENT_ACTION_SCOPES.instagram] as const;

export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return REQUIRED_SCOPES.filter((scope) => !have.has(scope));
}
