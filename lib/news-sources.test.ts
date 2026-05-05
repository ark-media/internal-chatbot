import { describe, expect, it } from 'vitest';

import { isApprovedSource } from './news-sources';

describe('isApprovedSource', () => {
  describe('approved English outlets', () => {
    it('accepts root-domain Reuters', () => {
      expect(isApprovedSource('https://www.reuters.com/world/article-123')).toBe(true);
    });

    it('accepts subdomain Haaretz English', () => {
      expect(isApprovedSource('https://www.haaretz.com/middle-east-news/2026-05-04/something')).toBe(true);
    });

    it('rejects an unapproved outlet', () => {
      expect(isApprovedSource('https://www.bbc.com/news/world-middle-east-12345')).toBe(false);
    });
  });

  describe('X/Twitter', () => {
    it('accepts a tweet status URL from a listed handle', () => {
      expect(
        isApprovedSource('https://x.com/AmitSegal/status/1234567890'),
      ).toBe(true);
    });

    it('accepts twitter.com mirror of the same URL', () => {
      expect(
        isApprovedSource('https://twitter.com/AmitSegal/status/1234567890'),
      ).toBe(true);
    });

    it('is case-insensitive on the handle', () => {
      expect(
        isApprovedSource('https://x.com/amitsegal/status/1234567890'),
      ).toBe(true);
    });

    it('rejects a profile URL with no /status/ segment', () => {
      expect(isApprovedSource('https://x.com/AmitSegal')).toBe(false);
    });

    it('rejects an x.com route URL where the first segment is not a handle', () => {
      // x.com/i/status/... is the "intent/individual" route, not a real handle.
      expect(isApprovedSource('https://x.com/i/status/1234567890')).toBe(false);
      expect(isApprovedSource('https://x.com/intent/post?text=hi')).toBe(false);
    });

    it('rejects a tweet from an unlisted handle', () => {
      expect(
        isApprovedSource('https://x.com/elonmusk/status/1234567890'),
      ).toBe(false);
    });
  });

  it('rejects malformed URLs', () => {
    expect(isApprovedSource('not a url')).toBe(false);
    expect(isApprovedSource('')).toBe(false);
  });
});
