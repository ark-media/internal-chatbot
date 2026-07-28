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
