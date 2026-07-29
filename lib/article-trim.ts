// Trimming for fetched article text before it reaches the model.
//
// Tavily's advanced extraction of a whole-day liveblog page runs 200–515 KB,
// and most of it is boilerplate: nav chrome, sign-up links, and a
// Facebook/X/email share block repeated after every entry (stripping markdown
// link targets alone cuts a real 510 KB Times of Israel liveblog to ~189 KB).
// Handing that to the model buries the story in a haystack — and the 8-step
// tool loop re-sends it on every step. So: strip link plumbing, cap what the
// model sees, and when the writer's URL pins a specific liveblog entry via an
// anchor, guarantee that entry survives the cap.

// ~6k tokens. The median fetched article (19k chars over the last week of
// production) passes untouched; only the liveblog-scale pages get cut.
export const ARTICLE_TEXT_CAP = 24_000;

// Raw-text window kept around an anchor match. Liveblog entries run a few
// hundred to ~2k chars plus their share-link block; 3.5k each side spans the
// full entry plus a neighbor for context, before stripping shrinks it.
const ANCHOR_WINDOW = 3_500;

// Never shrink the head below this to make room for an anchor window.
const MIN_HEAD = 4_000;

// Markdown images go first (their alt text is not prose), then links keep
// their label, then bare URLs — including the percent-encoded monsters inside
// share links — vanish. All patterns are linear-time on 500 KB inputs.
export function stripLinkTargets(text: string): string {
  return (
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/[^\s)]+/g, '')
      // Bullet or heading lines whose content was only a link are now empty.
      .replace(/^[ \t]*[*\-•#>]+[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
  );
}

// The entry id a writer's liveblog URL pins: ?liveBlogItemId=123 (Haaretz) or
// a purely numeric #fragment. Slug fragments ("#main-content") are not
// anchors to a specific entry.
export function liveBlogAnchorId(url: string): string | null {
  const param = url.match(/[?&]liveBlogItemId=(\d+)/)?.[1];
  if (param) return param;
  return url.match(/#(\d+)$/)?.[1] ?? null;
}

export function isLiveBlogUrl(url: string): boolean {
  return /liveblog|live-blog|ty-article-live|live-updates|\/live\//i.test(url);
}

export type TrimmedArticle = {
  text: string;
  truncated: boolean;
  /** Length of the stripped (but uncapped) text the cap was applied to. */
  totalChars: number;
  trimNote?: string;
};

export function trimArticleText(
  url: string,
  rawText: string,
  cap = ARTICLE_TEXT_CAP,
): TrimmedArticle {
  const stripped = stripLinkTargets(rawText);
  if (stripped.length <= cap) {
    return { text: stripped, truncated: false, totalChars: stripped.length };
  }

  // Locate the anchored entry in the RAW text: the id only occurs inside URLs
  // (share links, permalinks), which stripLinkTargets removes — so the raw
  // window is found first, then stripped on its own.
  const anchor = liveBlogAnchorId(url);
  const anchorIdx = anchor ? rawText.indexOf(anchor) : -1;
  let anchorWindow = '';
  if (anchorIdx >= 0) {
    anchorWindow = stripLinkTargets(
      rawText.slice(Math.max(0, anchorIdx - ANCHOR_WINDOW), anchorIdx + ANCHOR_WINDOW),
    ).trim();
  }

  const headBudget = anchorWindow
    ? Math.max(MIN_HEAD, cap - anchorWindow.length - 100)
    : cap;
  const head = stripped.slice(0, headBudget);

  // Skip the append when the anchored entry already sits inside the head —
  // sampled by a distinctive slice of the window rather than the anchor id,
  // which stripping removed from both.
  const sample = anchorWindow.slice(200, 320).trim();
  const windowInHead = sample.length >= 40 && head.includes(sample);

  const parts = [head];
  const noteParts = [
    `Text trimmed from ${stripped.length} to ~${cap} characters.`,
  ];
  if (isLiveBlogUrl(url)) {
    noteParts.push(
      'This is a live-blog page; entries are listed newest first, so the retained head covers the most recent entries.',
    );
  }
  if (anchorWindow && !windowInHead) {
    parts.push(`[Trimmed. The live-blog entry referenced by the link's anchor follows:]`);
    parts.push(anchorWindow);
    noteParts.push(`The entry referenced by the link's anchor (${anchor}) is appended after the head.`);
  } else if (anchor && anchorIdx < 0) {
    noteParts.push(
      `The link's anchor id (${anchor}) was not found in the extracted text; the referenced entry may be missing.`,
    );
  }

  return {
    text: parts.join('\n\n'),
    truncated: true,
    totalChars: stripped.length,
    trimNote: noteParts.join(' '),
  };
}
