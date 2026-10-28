/** Use Meta's permalink when available (including reels), otherwise the post ID. */
export function facebookCommentUrl(postUrl: string | null, postId: string | null, externalId: string): string | null {
  if (!/^[0-9]+(?:_[0-9]+)?$/.test(externalId)) return null;
  let url: URL | undefined;
  if (postUrl) {
    try {
      const parsed = new URL(postUrl);
      if (parsed.protocol === 'https:' && ['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(parsed.hostname)
        && !parsed.username && !parsed.password && !parsed.port) url = parsed;
    } catch { /* Fall back to the known post ID. */ }
  }
  if (!url && postId && /^[0-9]+_[0-9]+$/.test(postId)) url = new URL(`https://www.facebook.com/${postId}`);
  if (!url) return null;
  url.searchParams.delete('reply_comment_id');
  url.searchParams.set('comment_id', externalId.split('_').pop()!);
  url.hash = '';
  return url.toString();
}

/** Instagram's web comment route uses the media shortcode, including for reels. */
export function instagramCommentUrl(postUrl: string | null, externalId: string, parentId?: string | null): string | null {
  if (!postUrl || !/^[0-9]+$/.test(externalId)) return null;
  try {
    const url = new URL(postUrl);
    if (url.protocol !== 'https:' || !['www.instagram.com', 'instagram.com'].includes(url.hostname)
      || url.username || url.password || url.port) return null;
    const media = /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)(?:\/c\/[0-9]+)?\/?$/.exec(url.pathname);
    if (!media) return null;
    const parent = parentId && /^[0-9]+$/.test(parentId) && parentId !== externalId ? parentId : null;
    return `https://www.instagram.com/p/${media[1]}/c/${parent ? `${parent}/r/${externalId}` : externalId}/`;
  } catch {
    return null;
  }
}
