import { describe, it, expect } from 'vitest';

import { parseRssItems, rssItemsToCandidates } from './rss';

describe('parseRssItems', () => {
  it('parses title, link, and pubDate from RSS 2.0 items', () => {
    const xml = `
      <rss><channel>
        <title>Feed</title>
        <item>
          <title>Ceasefire collapses in the north</title>
          <link>https://www.timesofisrael.com/ceasefire/</link>
          <pubDate>Thu, 02 Jul 2026 15:30:00 +0000</pubDate>
        </item>
        <item>
          <title>Second story</title>
          <link>https://www.timesofisrael.com/second/</link>
          <pubDate>Thu, 02 Jul 2026 14:00:00 +0000</pubDate>
        </item>
      </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toEqual([
      {
        title: 'Ceasefire collapses in the north',
        link: 'https://www.timesofisrael.com/ceasefire/',
        pubDate: 'Thu, 02 Jul 2026 15:30:00 +0000',
      },
      {
        title: 'Second story',
        link: 'https://www.timesofisrael.com/second/',
        pubDate: 'Thu, 02 Jul 2026 14:00:00 +0000',
      },
    ]);
  });

  it('unwraps CDATA titles and decodes entities', () => {
    const xml = `<rss><channel><item>
      <title><![CDATA[Israel & Iran: what's next]]></title>
      <link>https://www.bbc.co.uk/news/articles/abc</link>
      <pubDate>Thu, 02 Jul 2026 12:00:00 GMT</pubDate>
    </item></channel></rss>`;
    const [item] = parseRssItems(xml);
    expect(item.title).toBe("Israel & Iran: what's next");
  });

  it('decodes decimal and hex numeric character references', () => {
    const xml = `<rss><channel><item>
      <title>raising this week&#8217;s toll &#8230; &#x201C;quote&#x201D;</title>
      <link>https://www.timesofisrael.com/toll</link>
    </item></channel></rss>`;
    const [item] = parseRssItems(xml);
    expect(item.title).toBe('raising this week’s toll … “quote”');
  });

  it('falls back to dc:date and tolerates a missing date', () => {
    const xml = `<rss><channel>
      <item>
        <title>Has dc:date</title>
        <link>https://www.theguardian.com/world/a</link>
        <dc:date>2026-07-02T10:36:32Z</dc:date>
      </item>
      <item>
        <title>No date</title>
        <link>https://www.theguardian.com/world/b</link>
      </item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items[0].pubDate).toBe('2026-07-02T10:36:32Z');
    expect(items[1].pubDate).toBeNull();
  });

  it('skips items with no resolvable link', () => {
    const xml = `<rss><channel><item>
      <title>Linkless</title>
      <pubDate>Thu, 02 Jul 2026 12:00:00 GMT</pubDate>
    </item></channel></rss>`;
    expect(parseRssItems(xml)).toHaveLength(0);
  });
});

describe('rssItemsToCandidates', () => {
  it('strips tracking query strings and keeps approved sources', () => {
    const candidates = rssItemsToCandidates([
      {
        source: 'BBC',
        items: [
          {
            title: 'World story',
            link: 'https://www.bbc.co.uk/news/articles/xyz?at_medium=RSS&at_campaign=rss',
            pubDate: 'Thu, 02 Jul 2026 12:00:00 GMT',
          },
        ],
      },
    ]);
    expect(candidates).toEqual([
      {
        title: 'World story',
        url: 'https://www.bbc.co.uk/news/articles/xyz',
        source: 'BBC',
        publicationDate: 'Thu, 02 Jul 2026 12:00:00 GMT',
      },
    ]);
  });

  it('drops items from non-approved sources', () => {
    const candidates = rssItemsToCandidates([
      {
        source: 'Random',
        items: [
          { title: 'Off-list', link: 'https://example.com/story', pubDate: null },
        ],
      },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('dedupes the same article carried by two feeds (query-normalized)', () => {
    const candidates = rssItemsToCandidates([
      {
        source: 'BBC',
        items: [{ title: 'A', link: 'https://www.bbc.co.uk/news/x?at_medium=RSS', pubDate: null }],
      },
      {
        source: 'BBC',
        items: [{ title: 'A dup', link: 'https://www.bbc.co.uk/news/x', pubDate: null }],
      },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe('https://www.bbc.co.uk/news/x');
  });
});
