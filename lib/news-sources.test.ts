import { describe, expect, it } from 'vitest';

import {
  isApprovedSource,
  isHardPaywallSource,
  isInternationalSource,
} from './news-sources';

describe('isApprovedSource', () => {
  describe('approved English outlets', () => {
    it('accepts root-domain Reuters', () => {
      expect(isApprovedSource('https://www.reuters.com/world/article-123')).toBe(true);
    });

    it('accepts subdomain Haaretz English', () => {
      expect(isApprovedSource('https://www.haaretz.com/middle-east-news/2026-05-04/something')).toBe(true);
    });

    it('accepts the newly added internationals (BBC, Guardian, WaPo, FT)', () => {
      expect(isApprovedSource('https://www.bbc.com/news/world-middle-east-12345')).toBe(true);
      expect(isApprovedSource('https://www.bbc.co.uk/news/world-12345')).toBe(true);
      expect(isApprovedSource('https://www.theguardian.com/world/2026/may/04/israel')).toBe(true);
      expect(isApprovedSource('https://www.washingtonpost.com/world/2026/05/04/israel')).toBe(true);
      expect(isApprovedSource('https://www.ft.com/content/abc-123')).toBe(true);
    });

    it('rejects an unapproved outlet', () => {
      expect(isApprovedSource('https://www.cnn.com/2026/05/04/middleeast/israel')).toBe(false);
    });
  });

  describe('source tiers', () => {
    it('flags hard-paywall outlets', () => {
      expect(isHardPaywallSource('https://www.wsj.com/world/x')).toBe(true);
      expect(isHardPaywallSource('https://www.nytimes.com/2026/05/04/x')).toBe(true);
      expect(isHardPaywallSource('https://www.washingtonpost.com/world/x')).toBe(true);
      expect(isHardPaywallSource('https://www.ft.com/content/x')).toBe(true);
    });

    it('does not flag free outlets as hard-paywall', () => {
      expect(isHardPaywallSource('https://www.reuters.com/world/x')).toBe(false);
      expect(isHardPaywallSource('https://www.bbc.com/news/x')).toBe(false);
      expect(isHardPaywallSource('https://www.timesofisrael.com/x')).toBe(false);
    });

    it('flags the international tier (free and paywalled members)', () => {
      expect(isInternationalSource('https://www.reuters.com/world/x')).toBe(true);
      expect(isInternationalSource('https://www.theguardian.com/world/x')).toBe(true);
      expect(isInternationalSource('https://www.nytimes.com/2026/05/04/x')).toBe(true);
    });

    it('does not flag Israeli outlets as international tier', () => {
      expect(isInternationalSource('https://www.timesofisrael.com/x')).toBe(false);
      expect(isInternationalSource('https://www.ynetnews.com/x')).toBe(false);
      expect(isInternationalSource('https://www.jpost.com/x')).toBe(false);
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
