// Structured single-line JSON logging.
//
// Vercel's log drain parses one JSON object per line, so every event goes out
// as `{"event":"<name>",...fields}` with `event` first. These wrappers exist so
// that shape is stated once: the call sites were hand-rolled
// `console.warn(JSON.stringify({ event: '…', … }))`, which capped `String(err)`
// at 120, 200, 300, or not at all, with nothing behind the differences.
//
// Keep these dumb. They must never throw — a logging failure inside a `catch`
// would mask the error being reported.

// Error text long enough to identify a failure, short enough that a stack-laden
// message can't dominate a log line. Was the widest cap already in use.
const ERR_MAX = 300;

/**
 * Render an unknown caught value as log-safe text.
 *
 * Uses `String(err)`, not `err.message`, so an Error keeps its class name
 * ("TypeError: …") — that prefix is often the only clue about what threw.
 */
export function errText(err: unknown): string {
  return String(err).slice(0, ERR_MAX);
}

type Fields = Record<string, unknown>;

function line(event: string, fields?: Fields): string {
  return JSON.stringify({ event, ...fields });
}

/** Expected-but-notable: a degraded path, a dropped source, a caught error. */
export function warnEvent(event: string, fields?: Fields): void {
  console.warn(line(event, fields));
}

/** Routine telemetry: request finished, cache purged, sources extracted. */
export function logEvent(event: string, fields?: Fields): void {
  console.log(line(event, fields));
}

/** Something is misconfigured or broken and a human needs to look. */
export function errorEvent(event: string, fields?: Fields): void {
  console.error(line(event, fields));
}
