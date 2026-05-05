# News Script Generation Orchestrator: Formal Specification

**Status**: Ready for implementation  
**Last Updated**: 2026-05-05  
**Audience**: Developers implementing the news script orchestrator

---

## 1. Overview

The News Script Orchestrator automates the end-to-end generation of broadcast-ready news scripts for *Ark News Daily*, a 6–10 minute daily news briefing. The system parallelizes source gathering, identifies the 3 most newsworthy topics, pauses for writer validation, then automatically generates and refines the script until it meets quality standards.

**Goals:**
- Fully automated script generation (no manual writing required from LLM perspective)
- Single human interaction point: topic validation at source-gathering checkpoint
- Deterministic script quality via automated reflect loop with max 3 iterations
- Complete transparency of sources and reasoning through the pipeline

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ADVISOR STRATEGY                               │
│  Sonnet (executor) runs main pipeline; Opus (advisor) judges script quality │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ SOURCE GATHERING AGENT (Sonnet)                                     │
│ (Parallelized with Example Loading)                                 │
├──────────────────┬──────────────────────────────────────────────────┤
│ • Google Search  │ • Load example scripts from lib/news-examples.md  │
│   grounding      │                                                   │
│ • Fetch articles │                                                   │
│   from prev 24h  │                                                   │
└──────────┬───────┴──────────────────────────┬───────────────────────┘
           │ (Wait for all sources to arrive) │
           ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ DISTILL AGENT (Sonnet)                                              │
│ • Group articles by topic/theme                                     │
│ • Rate sources: relevance + credibility + completeness              │
│ • Identify top 3 topics by interest                                 │
│ • Organize output: Topic → [ranked sources]                         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │ WRITER CHECKPOINT   │
                 │                     │
                 │ Writer reviews:     │
                 │ • Topics + sources  │
                 │ • Can approve       │
                 │ • Can reject        │
                 │ • Can request more  │
                 │   fetches           │
                 └──────────┬──────────┘
                            │
                 (Additional fetches, if any)
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SCRIPT CRAFTING AGENT (Sonnet)                                      │
│ • Takes approved sources + any additional raw articles              │
│ • Writes 2–4 story blocks per lib/news-prompt.ts                    │
│ • Returns: complete script with citations + source list             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
        ┌────────────────────────────────────────────────┐
        │ REFLECT LOOP (Sonnet executor, Opus advisor)   │
        │                                                 │
        │ Max 3 iterations:                              │
        │ 1. Sonnet: pass script to Opus reviewer        │
        │ 2. Opus: analyze vs. editorial checklist       │
        │    + example scripts, return problems +        │
        │    corrections + decision                      │
        │ 3. If decision="exit" (<3 problems):           │
        │    return script to user                       │
        │ 4. If decision="loop" (≥3 problems):           │
        │    Sonnet passes corrections to Script         │
        │    Crafting, loops back to step 1              │
        │ 5. At iteration 3: exit (max reached)          │
        │                                                 │
        │ Output: final script only                      │
        └──────────┬────────────────────────────────────┘
                   │
                   ▼
            ┌────────────────┐
            │ USER (Writer)  │
            │ Reviews final  │
            │ script offline │
            └────────────────┘
```

---

## 3. Agent Specifications

### 3.1 Source Gathering Agent

**Purpose**: Fetch relevant news articles from the previous 24 hours using real-time search.

**Inputs**:
- `today: string` — ISO 8601 date (e.g., "2026-05-05")
- `timezone: string` — User's timezone for "acceptable date range" calculation (used in existing system)

**Process**:
1. Calculate acceptable publication date range:
   - If regular day: articles published on `yesterday` only
   - If Monday: articles published on `dayBefore` (Sunday) or `today` (Monday morning)
   - Use `newsContextForDate()` from `lib/news-prompt.ts`

2. Use Google Search grounding with Gemini 2.5 Flash:
   ```typescript
   // Pseudocode
   const { text, sources, providerMetadata } = await generateText({
     model: google('gemini-2.5-flash'),
     tools: {
       google_search: google.tools.googleSearch({}),
     },
     prompt: `Find the top 10–15 news articles about Israel, Jews, and the Middle East published on [DATE RANGE]. Return title, URL, publication date, and source outlet.`,
   });
   ```

3. Validate each article:
   - Publication date is within acceptable range (flag if outside)
   - URL is accessible (attempt fetch via Tavily Extract if paywall/JS-heavy)
   - Extract article text, title, date, source

4. Return unranked list of articles with metadata.

**Outputs**:
```typescript
type Article = {
  title: string;
  url: string;
  publicationDate: string; // ISO 8601 or null if unavailable
  source: string; // outlet name
  content: string; // full article text
  isFlagged?: boolean; // true if publication date outside acceptable range
  fetchError?: string; // if article couldn't be fetched
};

return Article[];
```

**Parallelization**: This agent runs in parallel with example script loading (see Agent 2 init).

**Error Handling**:
- If Google Search returns no results: return empty array, proceed to writer with "no sources found" message
- If most articles are flagged (outside date range): warn writer but proceed
- If article fetch fails: include fetch error in metadata, flag for writer review

---

### 3.2 Distill Agent

**Purpose**: Group articles by topic, rate sources, and identify the 3 most newsworthy topics.

**Inputs**:
- `articles: Article[]` — output from Source Gathering Agent
- `exampleScripts: string` — prior Ark News Daily scripts (for tone/scope reference)

**Process**:
1. Parse articles into topics:
   - Use LLM to group articles by news theme/topic (e.g., "Strait of Hormuz tensions", "Gaza ceasefire talks", "Iran nuclear program")
   - Allow overlap (one article can map to multiple topics if relevant)

2. For each topic, rate all associated sources by:
   - **Relevance**: Does this article directly address the topic? (0–100%)
   - **Credibility**: Is the outlet reputable for this type of coverage? (0–100%)
   - **Completeness**: Does this article add new information or just repeat earlier coverage? (0–100%)

3. Rank topics by "interestingness":
   - Primary signal: newsiness (new developments, major policy shifts, direct impact on Ark's audience)
   - Secondary signal: source quality (higher-credibility sources preferred)
   - Tertiary signal: completeness (breadth of available reporting)

4. Select top 3 topics.

**Outputs**:
```typescript
type TopicWithSources = {
  topic: string; // e.g., "Strait of Hormuz tensions"
  description: string; // 1–2 sentence summary of the topic
  articles: {
    article: Article;
    relevance: number; // 0–100
    credibility: number; // 0–100
    completeness: number; // 0–100
    avgScore: number; // (relevance + credibility + completeness) / 3
  }[];
};

return {
  topics: TopicWithSources[]; // length 3 (or fewer if <3 topics exist)
  rationale: string; // brief explanation of why these 3 topics chosen
};
```

**Error Handling**:
- If fewer than 3 topics exist in sources: return all available topics (proceed with <3)
- If all sources are low-credibility: flag this for writer, proceed anyway

---

### 3.3 Writer Checkpoint

**Purpose**: Validate topic selection and allow manual augmentation before automated script generation.

**Interaction**:
1. System displays `TopicWithSources[]` grouped by topic, showing:
   - Topic name + description
   - Ranked sources (with relevance/credibility/completeness scores)

2. Writer can:
   - **Approve**: Accept all 3 topics as-is, proceed to Script Crafting
   - **Reject**: Remove one or more topics from consideration
   - **Request additional fetches**: Ask system to fetch more articles for a specific topic (e.g., "I read about X yesterday but it wasn't fetched — can you find more on this?")

3. If writer requests additional fetches:
   - Source Gathering Agent re-runs for that topic/keyword
   - Results are **merged with existing articles for that topic** (no new distill pass)
   - Writer approves the augmented topic list

**Data Flow to Next Agent**:
- Pass approved topics + all articles (original + any augmented) to Script Crafting Agent
- Include metadata: which articles are from augmentation, which are original

---

### 3.4 Script Crafting Agent

**Purpose**: Write a broadcast-ready script from approved sources.

**Inputs**:
- `topics: TopicWithSources[]` — approved topics with ranked sources (from Writer Checkpoint or Script Crafting loop correction)
- `systemPrompt: string` — `newsSystemPrompt()` from `lib/news-prompt.ts`
- `exampleScripts: string` — loaded at start (from Source Gathering parallelization)
- `additionalArticles?: Article[]` — any articles added by writer at checkpoint

**Process**:
1. For each approved topic, construct a "story block":
   - **What happened**: Core facts from highest-credibility sources
   - **Why it matters**: Context and significance (use examples + system prompt as reference)
   - **Forward-looking insight**: What to watch for next

2. Structure script as 2–4 blocks (A/B/C/D):
   - A Block (~300–400 words): lead story
   - B Block (~300–400 words): second story
   - C Block (~150–250 words): lighter close
   - D Block (optional, ~200 words): fourth story

3. Follow all rules from `lib/news-prompt.ts`:
   - Voice & tone (clear-headed, warm, conversational, not AI-like)
   - Audio-first pacing (short sentences, clear pauses/line breaks)
   - Factual accuracy (superscript citations for every claim)
   - Plain language (translate jargon, no >2-clause sentences)
   - Transitions (smooth logical flow, no jarring pivots)
   - SOT clips (1–2 per story block where available, contextualized)
   - Inline FLAGS for uncertain/weak claims

4. Generate complete script with:
   - Sonic ID + intro
   - A/B/C(/D) blocks with HOST: labels
   - Outro
   - SOURCES section with numbered list

5. Return: complete script text

**Outputs**:
```typescript
type Script = {
  fullText: string; // complete script ready for broadcast
  metadata: {
    wordCount: number;
    blockCount: number; // 2–4
    citedSources: number; // unique sources with superscripts
    flagCount: number; // [FLAG: ...] inline notes
  };
};
```

**Error Handling**:
- If script exceeds 1200 words: trim C/D blocks or reduce detail
- If script is <900 words: expand blocks or add forward-looking insight
- If a source has multiple contradictions: flag and note in script
- If no usable sources for a topic: remove that topic, script only 2–3 blocks

---

### 3.5 Reflect Agent (Automated Loop) — Executor with Opus Advisor

**Architecture**: Sonnet (executor) runs the reflect loop, calling Opus (advisor) as a tool for quality judgment at each iteration.

**Purpose**: Automatically review and refine script until it meets quality standards, using Opus for high-quality critique and correction guidance.

**Inputs** (Sonnet executor):
- `script: Script` — output from Script Crafting Agent (or updated script from loop iteration)
- `sources: Article[]` — all source articles used in script
- `editorialChecklist: string` — `lib/news-editorial-checklist.md`
- `exampleScripts: string` — for tone/voice reference

**Advisor Tool** (`reviewScriptWithOpus`):

Sonnet calls Opus as a single tool per iteration:

```typescript
const { problems, decision, corrections } = await reviewScriptWithOpus({
  script: Script,
  editorialChecklist: string, // full checklist from lib/news-editorial-checklist.md
  exampleScripts: string, // 2–3 prior Ark News Daily scripts as gold standard
});

type ReviewResult = {
  problems: Array<{
    type: "hard" | "soft";
    issue: string; // e.g., "Factual error" or "Voice/tone"
    detail: string; // specific problem description
  }>;
  decision: "loop" | "exit"; // based on: loop if ≥3 problems, exit if <3
  corrections: Array<{
    blockOrSection: string; // e.g., "A Block" or "Sources section"
    problem: string; // which problem this addresses
    suggestedFix: string; // specific text/structural correction
  }>;
};
```

**Opus Advisor Behavior**:

1. Receives script, editorial checklist, and example scripts
2. Reviews script against **ALL standards** in editorial checklist:
   - Story selection (each story new/insightful? 2–4 stories representing most important?)
   - Voice & tone (sounds like Deborah? conversational not formal? moments of humanity? smooth transitions? natural pacing?)
   - Structure (each block has what/why/forward-looking? A block framing upfront? C block warm close? SOT contextualized?)
   - Writing quality (explain not present? clarity over completeness? transitions guide? plain language? no word repetition? <2 clauses per sentence?)
   - Source fidelity (every superscript maps to source list? articles in acceptable date range? FLAGs clear? quotes exact and attributed? no inference beyond sources?)
   - Factual accuracy (names/titles/dates/numbers correct? no inference? chronology clear? uncertainty preserved? attributions match sources?)
   - Overall (daily habit-building? would Deborah record? absorb on first hearing?)

3. Identifies distinct problems:
   - **Hard failures** (must be fixed):
     - Factual inaccuracy (verifiable facts wrong)
     - Incorrect assumption (claim not in sources or contradicts sources)
     - Source fidelity violation (quote misattributed, FLAG missing, citation orphaned)
   - **Soft feedback** (guidance, not blockers):
     - Voice/tone misses Deborah's register
     - Structure imbalance (e.g., C block too long)
     - Clarity issue (jargon not translated, >2 clauses)
     - Pacing (too dense for audio)

4. Counts distinct problems (each unique issue = 1 problem, not severity-weighted)

5. Makes decision:
   - If **<3 distinct problems**: `decision = "exit"`
   - If **≥3 distinct problems**: `decision = "loop"`

6. Returns specific corrections for Sonnet to pass to Script Crafting Agent

**Sonnet Executor Loop Logic** (max 3 iterations):

```
iteration = 1
while iteration ≤ 3:
  // Get script (from crafting agent or previous iteration)
  script = scriptCraftingAgent.getScript()
  
  // Call Opus advisor for judgment
  review = await reviewScriptWithOpus(script, checklist, examples)
  
  if review.decision === "exit":
    // <3 problems found, ready to ship
    return script
  
  if review.decision === "loop" AND iteration < 3:
    // ≥3 problems found, loop again
    // Pass corrections to script crafting agent
    updatedScript = await scriptCraftingAgent.refine(review.corrections)
    iteration += 1
    continue
  
  if iteration === 3:
    // Max iterations reached, exit
    return script
```

**Outputs**:
```typescript
type ReflectResult = {
  finalScript: Script; // script ready for user review
  iterations: number; // 1–3
};
```

**Return to user**: Only `finalScript.fullText` (no review history shown; user sees only the final script)

**Error Handling**:
- If Script Crafting Agent can't implement Opus corrections: return script with note to writer
- If reflect loop exits at iteration 3: return script (Opus made best effort within iteration budget)
- If Opus advisor call fails: fall back to Sonnet's own judgment and exit loop with script

---

## 4. Data Flow & Integration

### 4.1 Entry Point

```typescript
// app/api/news/generate/route.ts (new endpoint, or extend existing news route)

export async function POST(req: Request) {
  const { today, timezone } = await req.json();

  // 1. Source Gathering + Example Loading (parallel)
  const [articles, exampleScripts] = await Promise.all([
    sourceGatheringAgent(today, timezone),
    loadExampleScripts(), // from lib/news-examples.md
  ]);

  // 2. Distill
  const distilledTopics = await distillAgent(articles, exampleScripts);

  // 3. Writer Checkpoint (pause for user input)
  // Return distilled topics to UI, wait for writer approval
  return Response.json({
    stage: "checkpoint",
    topics: distilledTopics,
    nextStage: "scriptCrafting",
  });
}

// When writer approves (separate endpoint):
export async function POST(req: Request) {
  const { approvedTopics, additionalArticles } = await req.json();

  // 4. Script Crafting
  const script = await scriptCraftingAgent(approvedTopics, additionalArticles, exampleScripts);

  // 5. Reflect Loop
  const reflectResult = await reflectAgentLoop(script, approvedTopics, exampleScripts);

  // 6. Return final script
  return Response.json({
    stage: "complete",
    script: reflectResult.finalScript.fullText,
  });
}
```

### 4.2 State Management

- Store in-progress state in session/database if orchestrator spans multiple HTTP requests
- Checkpoint state must include: distilled topics, all fetched articles, example scripts (for re-use in subsequent steps)

---

## 5. Quality Standards (from Editorial Checklist)

Reflect agent checks against all items in `lib/news-editorial-checklist.md`:

**Hard failures** (block acceptance):
- Factual accuracy errors (names, titles, dates, numbers incorrect)
- Incorrect assumptions (claims not in sources or contradicting sources)
- Source fidelity violations (missing citations, misquoted, wrong attribution)

**Soft feedback** (guidance, not blockers):
- Voice & tone doesn't match Deborah's register
- Structure imbalances (e.g., A block missing framing, C block too long)
- Writing quality issues (jargon not translated, sentences >2 clauses, word repetition)
- Clarity issues (context missing, not explained where needed)
- Pacing issues (too dense for audio, no pauses)

---

## 6. Edge Cases & Handling

| Case | Handling |
|------|----------|
| Fewer than 3 newsworthy topics | Proceed with <3 topics (distill still runs, just returns smaller list) |
| Writer rejects all topics | Script Crafting does not run; return error to user |
| Writer requests additional fetches, but none found | Proceed with original topic sources |
| Script exceeds 1200 words after first draft | Reflect flags as soft feedback; Script Crafting trims C/D blocks |
| Script is <900 words | Reflect flags as soft feedback; Script Crafting expands blocks |
| Hard failure not fixable in 3 loops | Exit loop, return script with note to writer for manual fix |
| All sources are low-credibility | Distill warns; proceed anyway (writer can reject at checkpoint) |
| Article fetch fails (paywall, etc.) | Mark as flagged in metadata; Reflect can deprioritize for citations |

---

## 7. Advisor Strategy: Cost & Quality Model

**Pattern**: Executor-Advisor separation using Claude models strategically.

**Rationale**:
- **Sonnet (Executor)**: Runs all main pipeline agents (source gathering, distill, script crafting)
  - Fast, cost-effective for routine tasks (fetching, grouping, writing)
  - Capable enough for structured data work
  
- **Opus (Advisor)**: Called only in reflect loop for quality judgment
  - Reserved for high-stakes decision: is the script ready to broadcast?
  - Reviews against comprehensive editorial checklist + gold standard examples
  - Makes the final call on accept/reject + provides specific corrections

**Cost Impact**:
- ~90% of compute done by Sonnet (cheap)
- ~10% by Opus (expensive, but only where it matters)
- Max Opus calls: 3 per script generation (one per reflect iteration)
- Typical cost: single Sonnet pass + 1–2 Opus calls

**Quality Impact**:
- Critical gate (reflect loop) gets high-capability review
- Script output quality determined by Opus judgment
- Specific corrections from Opus guide refinement
- Gold standard examples keep tone aligned with Deborah's voice

**Future Expansion**:
- Could extend Opus advisor to: topic selection validation, factual accuracy spot-checks (early in pipeline)
- Pattern scales: executor handles volume, advisor handles judgment

---

- [ ] **Source Gathering Agent**
  - [ ] Set up Google Search grounding with Gemini 2.5 Flash
  - [ ] Calculate acceptable date range per `newsContextForDate()`
  - [ ] Fetch and validate articles
  - [ ] Handle errors (no results, fetch failures, date mismatches)

- [ ] **Distill Agent**
  - [ ] Group articles by topic
  - [ ] Rate sources (relevance, credibility, completeness)
  - [ ] Rank topics by interestingness
  - [ ] Return top 3 (or fewer) topics with metadata

- [ ] **Writer Checkpoint UI**
  - [ ] Display topics with ranked sources
  - [ ] Allow approve/reject/request-more-fetches actions
  - [ ] Handle additional fetches (merge with existing, no new distill)
  - [ ] Validate approval before proceeding

- [ ] **Script Crafting Agent (Sonnet)**
  - [ ] Take approved topics + articles
  - [ ] Write 2–4 story blocks per system prompt
  - [ ] Apply voice/tone/structure rules
  - [ ] Add citations + source list
  - [ ] Handle errors (word count, missing context)

- [ ] **Reflect Agent Loop (Sonnet executor, Opus advisor)**
  - [ ] Sonnet: orchestrate reflect loop (max 3 iterations)
  - [ ] Implement `reviewScriptWithOpus()` tool that calls Opus
  - [ ] Opus: review script vs. editorial checklist + examples
  - [ ] Opus: return structured `{ problems, decision, corrections }`
  - [ ] Sonnet: parse decision, loop or exit
  - [ ] Sonnet: pass Opus corrections to Script Crafting Agent
  - [ ] Return final script only to user

- [ ] **Integration**
  - [ ] Endpoint(s) for orchestration
  - [ ] State management (session/DB) for multi-step flow
  - [ ] Error handling and logging

---

1. **Prompt engineering**: Each agent's prompt should reference relevant sections of `lib/news-prompt.ts` and `lib/news-editorial-checklist.md` as grounding.

2. **Example scripts**: Load once at start, cache for the entire orchestration run. Pass to every agent that needs tone/structure reference.

3. **Google Search grounding**: Gemini 2.5 Flash's `google_search` tool provides built-in source verification and metadata. Leverage `providerMetadata` for grounding references.

4. **Writer Checkpoint**: This is the only human interaction point. Make it clear and actionable; show structured data (topics + sources), not raw text.

5. **Opus advisor in reflect loop**: 
   - Tool signature: `reviewScriptWithOpus({ script, editorialChecklist, exampleScripts })`
   - Opus is called once per iteration with full context
   - Returns structured `{ problems, decision, corrections }`
   - Sonnet uses decision to control loop flow
   - Sonnet passes `corrections` to Script Crafting Agent for next iteration

6. **Reflect loop exit criteria**: <3 distinct problems found → exit. Count problems, not severity. Opus makes the count; Sonnet enforces the decision.

7. **Error resilience**: If any agent fails (no sources, topics, or script generation), return a clear error to the user with next steps (retry, manual input, etc.). Do not silently degrade.

---

## 10. Example Usage (Happy Path)

1. **User submits**: today="2026-05-05", timezone="America/New_York"
2. **System returns** (checkpoint): 3 topics with ranked sources
3. **Writer approves** all 3 topics
4. **System generates script**, runs 2 reflect iterations (finds 3 problems → loop 1, finds 2 problems → exit)
5. **System returns final script** to writer for offline review
6. **Writer edits/records** script as needed

---

## 11. Opus Advisor Prompt Template

When Sonnet calls `reviewScriptWithOpus()`, it should pass:

```typescript
const opusPrompt = `
You are a senior editor for Ark News Daily, a daily news briefing show hosted by Deborah Pardes.

Your job: Review the script below against the editorial checklist and examples. Identify problems and decide whether the script is ready.

EDITORIAL CHECKLIST (grade against each section):
[${editorialChecklist}]

GOLD STANDARD EXAMPLES (reference these for tone, voice, structure):
[${exampleScripts}]

SCRIPT TO REVIEW:
[${script.fullText}]

---

RESPONSE FORMAT:

Return ONLY valid JSON (no markdown, no explanation). Structure:

{
  "problems": [
    {
      "type": "hard" or "soft",
      "issue": "Issue name (e.g., 'Factual error', 'Voice/tone')",
      "detail": "Specific problem description"
    },
    ...
  ],
  "decision": "exit" or "loop",
  "corrections": [
    {
      "blockOrSection": "A Block" or "Sources section", etc,
      "problem": "Which problem this addresses",
      "suggestedFix": "Specific text or structural correction"
    },
    ...
  ]
}

DECISION LOGIC:
- Count the distinct problems.
- If fewer than 3 problems found: "decision": "exit"
- If 3 or more problems found: "decision": "loop"

IMPORTANT:
- Be specific. Don't say "improve voice"; say "Opening is too formal. Change 'Yesterday, the situation escalated' to 'Yesterday brought a major shift.'"
- Distinguish hard failures (factual, assumptions) from soft feedback (tone, clarity).
- Compare against the editorial checklist AND the gold standard examples.
- Return corrections that Script Crafting Agent can directly implement.
`;
```

This ensures Opus operates as a tool within Sonnet's loop, with clear input/output contracts.

---

**Ready to implement.** Contact or iterate on this spec as needed.
