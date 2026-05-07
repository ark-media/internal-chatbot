import { generateObject } from 'ai';
import { z } from 'zod';

// Pre-retrieval helper for the prep route. Extracts the three things we need
// to fan out before the model writes its first token:
//   - guests: full names of people who will be on the upcoming episode (so we
//     can pre-load their topic-filtered dossiers in parallel)
//   - topic: a few-word FTS phrase describing the episode subject (so the
//     dossier query narrows to relevant turns instead of returning a guest's
//     50 oldest appearances)
//   - urls: any links the user pasted (CFR columns, op-eds, etc.) — fetched
//     verbatim via Tavily Extract
//
// URL extraction is regex-based (deterministic, no LLM cost). Guests and topic
// come from a small Haiku call.

export type PrepExtraction = {
  guests: string[];
  topic: string | null;
  urls: string[];
};

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
// Match trailing punctuation that's clearly not part of the URL (parens from
// markdown links, sentence terminators). Note: `/` and `?` ARE legal trailing
// chars in URLs so we don't strip those.
const URL_TRAIL_RE = /[)\].,;!]+$/;
// Cap URLs per prep prompt. Each URL costs one Tavily Extract slot and ~12K
// chars of system-prompt body — a user pasting a long list of links should not
// be able to swamp the budget. Beyond this we trust the model to webSearch on
// demand. Five matches the typical prep-doc pattern (1–3 columns + a profile).
const MAX_URLS = 5;

export function extractUrls(text: string): string[] {
  const raw = text.match(URL_RE) ?? [];
  const cleaned = raw.map((u) => u.replace(URL_TRAIL_RE, ''));
  return Array.from(new Set(cleaned)).slice(0, MAX_URLS);
}

// Two capitalised words separated by whitespace — the typical guest-name
// shape. Used by the fast-path to decide whether a Haiku call is worthwhile.
const NAME_SHAPE_RE = /[A-Z][a-z]+\s+[A-Z][a-z]+/;

const extractSchema = z.object({
  guests: z
    .array(z.string())
    .describe(
      'Full names of people the user names as guests/interviewees of the upcoming episode. Use canonical spelling when obvious (e.g. "Nadav Eyal" not "Nadav"). Do NOT include third parties merely mentioned in linked articles, hosts of the show, or people referenced in passing. Empty array if no guests are named.',
    ),
  topic: z
    .string()
    .nullable()
    .describe(
      'ONE or TWO keywords describing the episode\'s subject, used as a Postgres FTS filter (AND semantics — every keyword in the topic must appear in a turn for that turn to match). Prefer one keyword unless two are clearly needed to disambiguate. Strip stopwords. Examples: "Iran" (preferred over "Iran nuclear agreement strategy"), "DOGE" (preferred over "DOGE federal agencies layoffs"), "Ukraine ceasefire" (two only if "Ukraine" alone would over-match). Null if no clear topic.',
    ),
});

export async function extractPrepContext(
  userText: string,
  today: string,
): Promise<PrepExtraction> {
  const urls = extractUrls(userText);
  const trimmed = userText.trim();

  if (trimmed.length === 0) {
    return { guests: [], topic: null, urls };
  }

  // Fast path: short prompts with no URL and no obvious guest-name token
  // almost never benefit from Haiku extraction (e.g. "hello", "give me five",
  // single-line clarifications). Skipping saves ~500ms of cold-call latency on
  // those turns. Real prep prompts always include either a guest name shaped
  // like "First Last" or a URL.
  if (
    trimmed.length < 80 &&
    urls.length === 0 &&
    !NAME_SHAPE_RE.test(trimmed)
  ) {
    return { guests: [], topic: null, urls };
  }

  try {
    const { object } = await generateObject({
      model: 'anthropic/claude-haiku-4-5',
      schema: extractSchema,
      system: {
        role: 'system',
        content: `You extract structured context from an episode-prep prompt for a podcast research assistant. Today is ${today}.

The user is preparing an episode of an Ark Media podcast (Call me Back, For Heaven's Sake, What's Your Number?, Ark News Daily, Inside Call me Back). They will name one or more guests and describe a topic. Your job is to surface the guest names and topic keywords so the assistant can pre-load past appearances and topical material.

Guests are the people the user explicitly names as being on the upcoming episode — typically signalled by phrases like "with X and Y", "guest is X", or "interviewing X". Do not include hosts (Dan Senor, Ilan Benatar, etc. — they're on every episode of their own shows) and do not include people mentioned only as authors of linked articles unless the user clearly says they're also a guest.

Topic should be ONE or TWO keywords — never more. The keyword(s) feed a Postgres full-text filter with AND semantics: every keyword in your topic must appear in a transcript turn for that turn to match, so each extra keyword shrinks recall geometrically. A guest's prior position on a subject is rarely captured in a single sentence that contains four narrow words. Default to one broad keyword (the subject everyone in the episode will be talking about — usually a country, person, or named event). Add a second keyword only when the first alone would be too generic (e.g. "Israel" + "hostages" if "Israel" alone over-matches the corpus). Drop stopwords. Concrete nouns and proper nouns over abstract framings.`,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      prompt: userText,
      temperature: 0,
    });
    return {
      guests: object.guests.map((g) => g.trim()).filter((g) => g.length > 0),
      topic: object.topic?.trim() || null,
      urls,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({ event: 'prep.extract_error', err: String(err) }),
    );
    return { guests: [], topic: null, urls };
  }
}
