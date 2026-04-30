import { describe, it, expect } from 'vitest';
import { formatErrorMessage } from './ChatErrorBanner';

describe('formatErrorMessage', () => {
  it('returns generic copy for an empty error message', () => {
    expect(formatErrorMessage(new Error(''))).toEqual({
      status: null,
      message: 'The chat request failed. Please try again.',
    });
  });

  it('extracts the HTTP status prefix produced by chatFetch', () => {
    expect(formatErrorMessage(new Error('[404 Not Found] /api/chat not found'))).toEqual({
      status: 404,
      message: '/api/chat not found',
    });
  });

  it('handles a status prefix with no body', () => {
    expect(formatErrorMessage(new Error('[502 Bad Gateway]'))).toEqual({
      status: 502,
      message: 'Bad Gateway',
    });
  });

  it('falls back to a generic message when the body is an HTML error page', () => {
    const html =
      '[404 Not Found] <!DOCTYPE html><html><body><h1>404</h1></body></html>';
    expect(formatErrorMessage(new Error(html))).toEqual({
      status: 404,
      message: 'Not Found',
    });
  });

  it('extracts an "error" field from a JSON body', () => {
    const json = '[400 Bad Request] {"error":"invalid_messages","detail":"missing parts"}';
    expect(formatErrorMessage(new Error(json))).toEqual({
      status: 400,
      message: 'invalid_messages',
    });
  });

  it('extracts a "detail" field when "error" is not a string', () => {
    const json = '[422 Unprocessable Entity] {"detail":"speaker is ambiguous"}';
    expect(formatErrorMessage(new Error(json))).toEqual({
      status: 422,
      message: 'speaker is ambiguous',
    });
  });

  it('passes plain text bodies through unchanged', () => {
    expect(formatErrorMessage(new Error('[429 Too Many Requests] Rate limit exceeded'))).toEqual({
      status: 429,
      message: 'Rate limit exceeded',
    });
  });

  it('handles errors with no status prefix (e.g., network failures)', () => {
    expect(formatErrorMessage(new Error('Failed to fetch'))).toEqual({
      status: null,
      message: 'Failed to fetch',
    });
  });

  it('does not treat a body that merely starts with a bracketed word as a status prefix', () => {
    expect(formatErrorMessage(new Error('[note] retry later'))).toEqual({
      status: null,
      message: '[note] retry later',
    });
  });

  it('handles multi-line bodies', () => {
    const err = new Error('[500 Internal Server Error] line 1\nline 2');
    expect(formatErrorMessage(err)).toEqual({
      status: 500,
      message: 'line 1\nline 2',
    });
  });
});
