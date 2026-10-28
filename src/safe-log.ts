/*
 * Whitelisted error logging. Error messages from drivers and libraries can
 * contain connection strings (with passwords), SQL text, row values or
 * customer message content, so they are never written to the log. Only a
 * fixed stage description, a sanitised error type, an optional SQLSTATE and an
 * optional event key are emitted.
 */

const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/;
const SQLSTATE = /^[A-Za-z0-9]{5}$/;
const UNKNOWN_ERROR_NAME = 'UnknownError';

/** `name` or `name (SQLSTATE xxxxx)`, built only from validated fields. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return UNKNOWN_ERROR_NAME;
  }

  const name = typeof error.name === 'string' && SAFE_NAME.test(error.name)
    ? error.name
    : UNKNOWN_ERROR_NAME;
  const { code } = error as { code?: unknown };

  return typeof code === 'string' && SQLSTATE.test(code)
    ? `${name} (SQLSTATE ${code})`
    : name;
}

/** `stage` must be a fixed string chosen by the caller, never derived from input. */
export function logSafeError(stage: string, error: unknown, eventKey?: string): void {
  const keySuffix = eventKey === undefined ? '' : ` (event_key ${eventKey})`;

  console.error(`${stage}${keySuffix}: ${describeError(error)}`);
}
