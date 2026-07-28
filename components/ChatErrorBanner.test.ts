import { describe, it, expect } from 'vitest';
import { formatErrorMessage } from './ChatErrorBanner';

const GENERIC = 'The chat request failed. Please try again.';

describe('formatErrorMessage', () => {
  // `chatFetch` throws `[<status> <statusText>] <body>`; this parses it back
  // apart. Case name, thrown message, expected status, expected message.
  it.each([
    ['empty message falls back to generic copy', '', null, GENERIC],
    [
      'status prefix and body',
      '[404 Not Found] /api/chat not found',
      404,
      '/api/chat not found',
    ],
    ['status prefix with no body uses the statusText', '[502 Bad Gateway]', 502, 'Bad Gateway'],
    [
      'HTML error page body falls back to the statusText',
      '[404 Not Found] <!DOCTYPE html><html><body><h1>404</h1></body></html>',
      404,
      'Not Found',
    ],
    [
      'JSON body "error" field',
      '[400 Bad Request] {"error":"invalid_messages","detail":"missing parts"}',
      400,
      'invalid_messages',
    ],
    [
      'JSON body "detail" field when "error" is not a string',
      '[422 Unprocessable Entity] {"detail":"speaker is ambiguous"}',
      422,
      'speaker is ambiguous',
    ],
    [
      'plain text body passes through',
      '[429 Too Many Requests] Rate limit exceeded',
      429,
      'Rate limit exceeded',
    ],
    ['no status prefix (e.g. network failure)', 'Failed to fetch', null, 'Failed to fetch'],
    [
      'bracketed word that is not a status prefix',
      '[note] retry later',
      null,
      '[note] retry later',
    ],
    [
      'multi-line body',
      '[500 Internal Server Error] line 1\nline 2',
      500,
      'line 1\nline 2',
    ],
  ])('%s', (_case, thrown, status, message) => {
    expect(formatErrorMessage(new Error(thrown))).toEqual({ status, message });
  });
});
