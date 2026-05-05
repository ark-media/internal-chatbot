import { generateText } from 'ai';

import { sql } from '../db';

let initPromise: Promise<void> | null = null;

export function ensureStyleProfileTable(): Promise<void> {
  return (initPromise ??= (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS writer_style_profile (
          id              INT PRIMARY KEY DEFAULT 1,
          profile_text    TEXT NOT NULL DEFAULT '',
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          runs_distilled  INT NOT NULL DEFAULT 0,
          CONSTRAINT writer_style_profile_singleton CHECK (id = 1)
        )
      `;
    } catch (err) {
      initPromise = null;
      console.error('Failed to ensure writer_style_profile table:', err);
      throw err;
    }
  })());
}

// Inline seed for the style profile. The DB row overrides this at runtime
// once distillation has happened. Kept inline (not as a .md file) so it
// survives Vercel's bundling without manual outputFileTracingIncludes
// configuration. Empty by default — populated through Save & Learn.
const FILE_SEED = '';

// Strip HTML comments and trim. Exported for unit testing; also useful if
// we ever switch back to a markdown seed that contains comment headers.
export function normalizeProfileText(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export type StyleProfile = {
  // Normalized text, ready to inject into a system prompt. Empty string
  // when nothing useful is available — callers should skip injection in
  // that case.
  text: string;
  source: 'db' | 'seed' | 'empty';
  updatedAt: string | null;
  runsDistilled: number;
};

export async function loadStyleProfile(): Promise<StyleProfile> {
  await ensureStyleProfileTable();
  const rows = (await sql`
    SELECT profile_text, updated_at, runs_distilled
      FROM writer_style_profile
     WHERE id = 1
  `) as unknown as Array<{
    profile_text: string;
    updated_at: Date | string;
    runs_distilled: number;
  }>;
  const row = rows[0];
  if (row && normalizeProfileText(row.profile_text).length > 0) {
    const updatedAt =
      typeof row.updated_at === 'string'
        ? row.updated_at
        : row.updated_at.toISOString();
    return {
      text: normalizeProfileText(row.profile_text),
      source: 'db',
      updatedAt,
      runsDistilled: row.runs_distilled,
    };
  }
  const normalized = normalizeProfileText(FILE_SEED);
  return {
    text: normalized,
    source: normalized.length > 0 ? 'seed' : 'empty',
    updatedAt: null,
    runsDistilled: row?.runs_distilled ?? 0,
  };
}

// Returns the new runs_distilled value after the upsert, so callers can
// report the truthful count instead of optimistically computing it.
export async function saveStyleProfile(profileText: string): Promise<{ runsDistilled: number }> {
  await ensureStyleProfileTable();
  const rows = (await sql`
    INSERT INTO writer_style_profile (id, profile_text, updated_at, runs_distilled)
    VALUES (1, ${profileText}, NOW(), 1)
    ON CONFLICT (id) DO UPDATE
      SET profile_text = EXCLUDED.profile_text,
          updated_at = NOW(),
          runs_distilled = writer_style_profile.runs_distilled + 1
    RETURNING runs_distilled
  `) as unknown as Array<{ runs_distilled: number }>;
  return { runsDistilled: rows[0]?.runs_distilled ?? 1 };
}

// ~1000 tokens at 4 chars/token. Bounds the size of the block injected into
// every script-craft system prompt. Lives inside the cached system block, so
// the cost is paid once per cache hit rather than per call.
export const MAX_PROFILE_CHARS = 4000;

const DISTILL_SYSTEM = `You are extracting RECURRING style preferences from how a writer revises news scripts.

You will see:
1. The current style profile (what we've learned so far).
2. The model's initial draft of a news script.
3. The writer's final revised draft.
4. The writer's refine instructions, in order.

Your job: produce an UPDATED style profile.

Rules for the profile:
- Capture only RECURRING preferences: voice, sentence rhythm, transition style, structural patterns, word choices, framing instincts — things the writer reliably wants different about generated drafts.
- IGNORE content-specific or one-off edits ("drop the cricket reference", "fix the date in block B", "use the Reuters source instead"). Those are about this run, not the writer.
- Keep entries short and concrete. Use bullet points. No preamble, no headers like "Updated profile:".
- If a new observation contradicts an existing rule, UPDATE the rule rather than appending a duplicate.
- If you can't extract any new style signal, return the current profile unchanged.
- Hard cap: ${MAX_PROFILE_CHARS} characters total. Drop the weakest entries before exceeding.

Output ONLY the profile text. No commentary, no markdown fences.`;

export type DistillInputs = {
  currentProfile: string;
  originalDraft: string;
  finalDraft: string;
  refineInstructions: string[];
};

// Pure function — exported so the prompt assembly is unit-testable without
// mocking the model call.
export function buildDistillPrompt(opts: DistillInputs): string {
  const { currentProfile, originalDraft, finalDraft, refineInstructions } =
    opts;

  const refineBlock =
    refineInstructions.length === 0
      ? '(no explicit refines — writer accepted the initial draft as-is)'
      : refineInstructions.map((s, i) => `${i + 1}. ${s}`).join('\n');

  return `== Current style profile ==

${currentProfile.length > 0 ? currentProfile : '(empty — first distillation)'}

== Initial AI draft ==

${originalDraft}

== Writer's final draft ==

${finalDraft}

== Writer's refine instructions (in order) ==

${refineBlock}

Produce the updated profile now.`;
}

export async function distillStylePreferences(
  opts: DistillInputs,
): Promise<string> {
  const { text } = await generateText({
    model: 'anthropic/claude-sonnet-4-6',
    system: DISTILL_SYSTEM,
    prompt: buildDistillPrompt(opts),
    temperature: 0.2,
  });

  let result = text.trim();
  if (result.length > MAX_PROFILE_CHARS) {
    result = result.slice(0, MAX_PROFILE_CHARS);
  }
  return result;
}

// Pure helper exported for testing. Encapsulates the save-learn idempotency
// rule: if the run's recorded `lastDistilledVersion` matches the current
// `refineHistory.length`, there is nothing new to learn from and the route
// should short-circuit instead of paying for another Sonnet call.
export function shouldSkipDistillation(opts: {
  refineHistoryLength: number;
  lastDistilledVersion: number | undefined;
}): boolean {
  return (
    typeof opts.lastDistilledVersion === 'number' &&
    opts.lastDistilledVersion === opts.refineHistoryLength
  );
}
