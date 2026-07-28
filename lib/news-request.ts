import { generateObject } from 'ai';
import { z } from 'zod';

type MessagePart = { type?: unknown; text?: unknown };

export type NewsRequestIntent =
  | 'cleanup'
  | 'outline'
  | 'single-block-draft'
  | 'full-episode-draft'
  | 'revision'
  | 'scan'
  | 'scan-integration'
  | 'draft';

export type NewsRequestRoute = {
  intent: NewsRequestIntent;
  block?: 'A' | 'B' | 'C' | 'D';
  immediateDraft: boolean;
};

type IncomingMessage = { role?: unknown; parts?: unknown };

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is MessagePart => typeof part === 'object' && part !== null)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function latestByRole(messages: readonly IncomingMessage[], role: string): string {
  const message = [...messages].reverse().find((m) => m.role === role);
  return textFromParts(message?.parts);
}

// Whether a breaking-news scan already presented suggestions in this
// conversation. The scan tool streams a data-breaking-suggestions part, so its
// presence is the ground truth for "scan-integration is even possible" —
// without it, "swap in the hostage story" is an ordinary revision.
function scanSuggestionsPresented(messages: readonly IncomingMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.parts) &&
      m.parts.some(
        (part: MessagePart) =>
          typeof part === 'object' && part !== null && part.type === 'data-breaking-suggestions',
      ),
  );
}

/**
 * Regex fallback used when the model classifier errors or times out. Kept
 * deliberately conservative; the LLM classifier above it handles the phrasing
 * variety this cannot.
 */
export function heuristicNewsRequestRoute(
  messages: readonly IncomingMessage[],
): NewsRequestRoute {
  const text = latestByRole(messages, 'user').toLowerCase();
  const block = text.match(/\b([abcd])\s*(?:-|\s)?block\b/i)?.[1]?.toUpperCase() as
    | 'A'
    | 'B'
    | 'C'
    | 'D'
    | undefined;
  const immediateDraft = /\b(?:write|draft|go ahead|create|produce)\b/.test(text);

  if (
    scanSuggestionsPresented(messages) &&
    /\b(?:accept|swap|integrate|replace|update)\b[\s\S]{0,120}\b(?:suggestion|swap|update|human-interest|story)\b/.test(text)
  ) {
    return { intent: 'scan-integration', block, immediateDraft };
  }
  if (
    /\b(?:scan|check|look)\b[\s\S]{0,90}\b(?:breaking news|what(?:'s| is) broken|more relevant|bigger stor)/.test(text) ||
    (/\bbreaking news\b/.test(text) && /\b(?:locked|miss(?:ed)?|since|finali[sz]ed)\b/.test(text))
  ) {
    return { intent: 'scan', block, immediateDraft };
  }
  if (/\b(?:clean up|tighten|polish|rewrite)\b[\s\S]{0,80}\b(?:sentence|line|paragraph|wording|phrase)/.test(text)) {
    return { intent: 'cleanup', block, immediateDraft };
  }
  if (/\b(?:outline|structure|organize)\b/.test(text) && !immediateDraft) {
    return { intent: 'outline', block, immediateDraft };
  }
  if (/\b(?:revise|redraft|rewrite|make (?:this|it)|shorten|conversational|punchier)\b/.test(text) && !immediateDraft) {
    return { intent: 'revision', block, immediateDraft };
  }
  if (block) return { intent: 'single-block-draft', block, immediateDraft };
  if (/\b(?:full episode|a\/b\/c|complete daily (?:news )?script)\b/.test(text)) {
    return { intent: 'full-episode-draft', immediateDraft };
  }
  return { intent: 'draft', immediateDraft };
}

// -- LLM classifier ----------------------------------------------------------

const routeSchema = z.object({
  intent: z.enum([
    'cleanup',
    'outline',
    'single-block-draft',
    'full-episode-draft',
    'revision',
    'scan',
    'scan-integration',
    'draft',
  ]),
  block: z
    .enum(['A', 'B', 'C', 'D'])
    .nullable()
    .describe('The script block the writer named by letter, else null'),
  immediateDraft: z
    .boolean()
    .describe('True only when the writer explicitly asks to produce the artifact now'),
});

const CLASSIFIER_SYSTEM = `You classify the latest writer message in the Ark News Daily editorial chat into one request mode. Answer only via the schema.

Intents:
- cleanup: fix, tighten, or polish specific wording — a sentence, line, or phrase.
- outline: produce an outline or structure notes, not a script.
- single-block-draft: write one script block. Set "block" only when the writer names the letter (A/B/C/D); "a block" or "one block" without a letter is still single-block-draft with block null.
- full-episode-draft: write a complete episode (SONIC ID, multiple blocks, sign-off).
- revision: change existing draft material — shorten, re-voice, restructure, or update a block with new information the writer supplies.
- scan: the writer has a finalized script and asks whether breaking or bigger news happened since it was locked ("did I miss anything?", "anything break overnight?").
- scan-integration: the writer accepts a specific suggestion that a breaking-news scan presented earlier in this conversation. Requires that a scan actually happened — the context notes whether one did.
- draft: any other script-writing request, or when none of the above clearly fits.

Rules:
- "Update/replace the B block with X" is a revision unless a scan presented suggestions earlier and the writer is accepting one of them.
- The indefinite article in "a block" does not mean the A block. Set "block" only for an explicitly named letter: "write a block on the strikes" → block: null; "write the A block" → block: "A".
- immediateDraft is true only for an explicit ask to produce the artifact now ("write it", "draft the block", "go ahead"). A question or discussion is false.
- Confirmation of an earlier readback ("yes, that's right — go ahead") is the intent of the request being confirmed, usually draft or single-block-draft.`;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/**
 * Classify the latest writer instruction with a small model call. Falls back
 * to the regex heuristic on any error or timeout so the route never fails on
 * classification. This only makes the task shape explicit; source and
 * editorial judgement stay with the main model, and the resulting mode note is
 * advisory — the writer's words always win.
 */
export async function classifyNewsRequest(
  messages: readonly IncomingMessage[],
): Promise<NewsRequestRoute> {
  const latest = latestByRole(messages, 'user');
  if (!latest.trim()) return { intent: 'draft', immediateDraft: false };

  const previous = latestByRole(messages, 'assistant');
  const prompt = `Previous assistant message (may be empty):
"""
${clip(previous, 1200)}
"""

A breaking-news scan presented suggestions earlier in this conversation: ${
    scanSuggestionsPresented(messages) ? 'yes' : 'no'
  }

Latest writer message:
"""
${clip(latest, 4000)}
"""`;

  try {
    const { object } = await generateObject({
      model: 'anthropic/claude-haiku-4-5',
      schema: routeSchema,
      system: {
        role: 'system',
        content: CLASSIFIER_SYSTEM,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      prompt,
      temperature: 0,
      abortSignal: AbortSignal.timeout(4000),
    });
    return {
      intent: object.intent,
      block: object.block ?? undefined,
      immediateDraft: object.immediateDraft,
    };
  } catch {
    return heuristicNewsRequestRoute(messages);
  }
}

// -- Mode instruction --------------------------------------------------------

const ADVISORY =
  "This mode was auto-detected from the writer's latest message. If the writer clearly asked for a different operation, follow the workflow that matches their words instead.";

export function newsRequestInstruction(route: NewsRequestRoute): string {
  const block = route.block ? `[${route.block} BLOCK]` : 'the requested block';
  const readbackPolicy = route.immediateDraft
    ? '“Write” asks for the finished artifact, but does not waive the understanding readback for a first, source-heavy script request. Skip it only when the writer explicitly says to skip the readback.'
    : 'Use the understanding gate for a first, source-heavy substantive script request unless the writer explicitly says to skip it.';

  const body = (() => {
    switch (route.intent) {
      case 'cleanup':
        return `== Active Request Mode: EDITORIAL RESPONSE — CLEANUP ==
Edit only the requested wording. Do not use the understanding gate, tools, script wrapper, SONIC ID, HOST intro, sign-off, sources list, or unrelated editorial analysis. Give concise alternatives only when useful.`;
      case 'outline':
        return `== Active Request Mode: EDITORIAL RESPONSE — OUTLINE ==
Return an outline only. Do not write a script wrapper, SONIC ID, HOST intro, sign-off, or extra blocks. Do not run the understanding gate; state concise assumptions or source gaps instead.`;
      case 'revision':
        return `== Active Request Mode: SCRIPT REVISION ==
Return only the requested revision. Preserve every existing beat unless the writer asks to cut or re-weight it. Do not add a full-episode wrapper or unrelated blocks. Do not run the understanding gate.`;
      case 'single-block-draft':
        return `== Active Request Mode: SINGLE-BLOCK SCRIPT ==
Output exactly ${block} and its requested supporting sources. Never add SONIC ID, HOST intro, sign-off, or another block. A first, source-heavy request for one block still requires the six-dimension readback and writer confirmation before drafting. ${readbackPolicy}`;
      case 'full-episode-draft':
        return `== Active Request Mode: FULL-EPISODE SCRIPT ==
Write a complete episode only after any required source verification. ${readbackPolicy}`;
      case 'scan':
        return `== Active Request Mode: BREAKING-NEWS SCAN ==
This is suggestions-only. Call scanBreakingNews and do not draft, revise, or run the understanding gate.`;
      case 'scan-integration':
        return `== Active Request Mode: BREAKING-NEWS INTEGRATION ==
Follow the per-story understanding gate in the Breaking-News Integration workflow, then modify only the accepted story and the sources it requires.`;
      default:
        return `== Active Request Mode: SCRIPT DRAFT ==
Follow the writer's explicit scope. ${readbackPolicy}`;
    }
  })();

  return `${body}\n${ADVISORY}`;
}
