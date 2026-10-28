/*
 * Meta webhooks mix time units. All unit knowledge lives in this file so the
 * adapters never multiply or divide by 1000 themselves.
 *
 * Assumptions (written from memory and inference of the Meta webhook structure;
 * NOT checked against the official documentation or any real captured payload):
 * - messaging[].timestamp is Unix MILLISECONDS      -> millisecondsToIso
 * - entry.time and changes[].value.created_time are Unix SECONDS
 *                                                   -> secondsToIso
 *
 * Both functions are pure: a missing or invalid value yields null, never the
 * current time.
 */

/*
 * Plausibility window (fixed constants, never derived from the current time):
 * 2000-01-01T00:00:00Z inclusive to 2100-01-01T00:00:00Z exclusive. It catches
 * unit mix-ups (milliseconds read as seconds land far beyond 2100, seconds read
 * as milliseconds land in January 1970) and zero/placeholder values, and keeps
 * every result a standard 4-digit-year ISO string.
 */
const WINDOW_START_MS = Date.UTC(2000, 0, 1);
const WINDOW_END_MS = Date.UTC(2100, 0, 1);

function toIso(epochMilliseconds: unknown): string | null {
  if (
    typeof epochMilliseconds !== 'number' ||
    !Number.isFinite(epochMilliseconds) ||
    epochMilliseconds < WINDOW_START_MS ||
    epochMilliseconds >= WINDOW_END_MS
  ) {
    return null;
  }

  return new Date(epochMilliseconds).toISOString();
}

export function millisecondsToIso(value: unknown): string | null {
  return toIso(value);
}

export function secondsToIso(value: unknown): string | null {
  return typeof value === 'number' ? toIso(value * 1000) : null;
}
