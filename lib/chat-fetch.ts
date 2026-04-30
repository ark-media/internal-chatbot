// Wraps `fetch` so that non-2xx chat responses become Errors that include the
// HTTP status. The AI SDK's HttpChatTransport otherwise throws with only the
// response body, which loses the status code (e.g. 404, 502) — and a Next.js
// 404 body is HTML, which is useless to display verbatim.
//
// Format: `[<status> <statusText>] <body-text>` — `ChatErrorBanner` parses
// this prefix back out for display.
export const chatFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[${response.status} ${response.statusText}] ${body}`.trim());
  }
  return response;
};
