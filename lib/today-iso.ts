/**
 * Today as YYYY-MM-DD on the *local* calendar.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is UTC, so for a writer
 * west of Greenwich it rolls over to tomorrow's date during the evening, and
 * the whole news pipeline is anchored to the writer's calendar day. Uses the
 * local-time getters so "today" means what the person at the desk means.
 *
 * Downstream this string is re-read as a UTC calendar date so subsequent
 * arithmetic matches the writer's calendar regardless of server timezone —
 * see `parseLocalDate` in `lib/orchestrator/source-gathering.ts` and
 * `newsContextForDate` in `lib/news-prompt.ts`.
 *
 * Kept dependency-free so client components and standalone scripts can both
 * import it without dragging in anything server-side.
 */
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Today as YYYY-MM-DD on the America/New_York calendar.
 *
 * The news pipeline is anchored to the show's clock, not the machine's or the
 * writer's: episodes are recorded "at 7 p.m. New York time" and the
 * acceptable-dates window keys off that recording day. On the server (UTC),
 * `toISOString()` rolls to tomorrow at 8 p.m. New York time — mid-way through
 * the evening writing session — and `todayISO()` on a London writer's machine
 * rolls at 7 p.m. New York time, both silently shifting the window and the
 * computed air date. 'en-CA' is the locale whose date format is YYYY-MM-DD.
 */
export function todayISONewYork(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
