// Split a buffer of newline-delimited JSON into the complete lines it contains
// plus the trailing partial line (everything after the last '\n', which may
// still be mid-write). Pure + synchronous so a streaming consumer can feed it
// decoded chunks one at a time — `rest` carries forward to the next chunk — and
// so it can be unit-tested without a real stream. Blank lines are dropped.
export function takeCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}
