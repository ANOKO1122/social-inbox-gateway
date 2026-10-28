/*
 * Helpers that prepare an already signature-verified webhook payload for
 * storage. They only ever work on the parsed copy: the raw bytes used for the
 * HMAC check are never touched.
 */

/**
 * Maximum nesting depth accepted for a webhook payload. Real Meta payloads are
 * a handful of levels deep; the limit exists so that a pathologically nested
 * (but validly signed) body is rejected with 400 instead of overflowing the
 * stack in recursive code and turning into a 500 that Meta would retry forever.
 */
export const MAX_PAYLOAD_DEPTH = 64;

/** Iterative (stack-safe) check that `value` nests at most `maxDepth` levels. */
export function exceedsMaxDepth(value: unknown, maxDepth: number = MAX_PAYLOAD_DEPTH): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };

    if (typeof node !== 'object' || node === null) {
      continue;
    }

    if (depth > maxDepth) {
      return true;
    }

    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }

  return false;
}

function cleanString(value: string): string {
  // toWellFormed() swaps each lone surrogate for U+FFFD and leaves correctly
  // paired surrogates (emoji) untouched.
  return value.replaceAll('\u0000', '').toWellFormed();
}

/**
 * Returns a copy of `value` that PostgreSQL `jsonb` will accept: every U+0000
 * is removed and every lone UTF-16 surrogate is replaced with U+FFFD, in
 * string values and object keys alike.
 *
 * Deliberate trade-off: `jsonb` rejects `\u0000` and unpaired surrogates (e.g.
 * an emoji cut in half by UTF-16 truncation: "Unicode low surrogate must
 * follow a high surrogate"). A single such character inside a customer message
 * would make the INSERT fail, the webhook answer 500 and Meta retry the same
 * poison message forever. We would rather alter an invisible or already
 * broken character in the stored copy than lose the event. If two keys
 * collapse to the same name after cleaning, the later one wins.
 *
 * Callers must only pass depth-limited payloads (see `exceedsMaxDepth`).
 */
export function sanitizeForJsonb(value: unknown): unknown {
  if (typeof value === 'string') {
    return cleanString(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForJsonb);
  }

  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      // defineProperty keeps an own "__proto__" key as plain data instead of
      // invoking the prototype setter.
      Object.defineProperty(copy, cleanString(key), {
        value: sanitizeForJsonb(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return copy;
  }

  return value;
}
