# PRD: Breaking-News Scan for Ark News Daily

## Self-Clarification

1. **Problem/Goal:** Ark News Daily records at 6pm NYC. Between 4–6pm the script is *finalized* but not yet recorded. During that window news can break that (a) is bigger than a story already in the lineup, (b) materially overtakes a story already in the script, or (c) is so large the broadcast would look out of touch omitting it. Writers currently have no systematic way to check this in the ~2-hour gap; they rely on ad-hoc scrolling. This adds a deliberate "scan for breaking news since I locked this" step to the existing news chat mode.
2. **Core Functionality:** (a) Writer uploads/pastes the finalized script into news chat and triggers a scan; (b) system discovers post-lock stories from the approved outlet set, diffs them against what the script already covers, and grades significance; (c) system returns ranked, labeled *suggestions* in three tiers (Swap / Update / Can't-ignore) with sourcing and confidence — and does not edit the script on that first turn.
3. **Scope/Boundaries:** Does NOT rewrite the script, does NOT auto-swap stories, does NOT run continuously/on a timer (v1 is on-demand per scan), does NOT discover via new outlets outside `lib/news-sources.ts`, does NOT re-grade the existing lineup with numeric scores. Reuses the orchestrator's discovery stack rather than inventing new fetching.
4. **Success Criteria:** Given a finalized script + a lock time, a scan returns a tiered suggestion list where every item passes all three gates; already-covered stories and hard-excluded categories never appear; a scan on a quiet window returns an explicit "nothing breaking" result rather than manufacturing flags; the script text is never mutated on the scan turn.
5. **Constraints:** Next.js 16 App Router (`app/api/news/...`), AI SDK v6 (`streamText`/`generateObject` + `toUIMessageStreamResponse`), `anthropic('claude-sonnet-4-6')`, Node runtime, `maxDuration = 300`. No new outlet infra. Reuse `lib/orchestrator/source-gathering.ts`, `lib/news-sources.ts`, `extractSources` from `app/api/news/route.ts`. No DB migration required for v1 (scan is stateless within the chat turn).

---

## 1. Introduction/Overview

A breaking-news scan extension to the existing **Ark News Daily** news chat mode. During the 4–6pm pre-record window a writer uploads the finalized script and triggers a scan. The system searches the approved news sources for stories that broke **after the script was locked**, compares them against what the script already covers, judges their significance, and surfaces a short ranked list of **suggestions** — never edits — so the writer can decide whether to swap in a story, update an existing one, or acknowledge a can't-ignore event.

The definition of "breaking" is fixed by the three-gate model agreed during design (see Functional Requirements). The feature is an **exception detector** tuned against false alarms: a bad flag at 5:45pm that makes a writer re-open a locked script is costly, so the bar is deliberately high and every flag carries its sourcing and confidence.

## Interaction Flow (two phases, multi-turn)

The feature is a small state machine layered on the news chat. The scan and the existing "confirm story understanding" gate (commit `076ae6d`) are **separate phases** — the gate is deferred and runs **per accepted story**, never during the scan.

```
[finalized script present] + writer asks "check for breaking news / more relevant stories"
        │
        ▼
PHASE 1 — SCAN & RECOMMEND  (hard gate: model MUST call scanBreakingNews first)
  • run discovery + three gates → ranked Swap / Update / Can't-ignore suggestions
  • NO script edits, NO drafting, NO understanding gate yet
        │
        ▼
writer accepts a specific replacement ("swap in X for the C-block story")
        │
        ▼
PHASE 2 — CONFIRM & INTEGRATE  (per accepted story, independently)
  • enter the EXISTING 5-dimension understanding gate for story X only
    (fetch its full sources, read back understanding, wait)
  • writer confirms understanding
  • model writes the replacement into the script (revised block)
        │
        └── writer may accept another suggestion → its own Phase-2 gate
```

Key rules:
- **Phase 1 is a hard gate.** With a finalized script present and a breaking/relevance request, the model must call `scanBreakingNews` before any edit or draft. It may not draft or edit in Phase 1.
- **The confirmation gate is understanding-readback only** (reuse `076ae6d`); corroboration/significance was already judged in the scan.
- **The gate is per-story.** Each accepted replacement runs its own understanding gate; accepting one story does not integrate the others.
- Expensive per-story work (full source fetch + readback) happens only for stories the writer commits to.

## 2. Goals

- Let a writer scan for post-lock breaking news from inside the existing news chat, with a finalized script as input.
- Enforce the three-gate definition (Exclusions → Recency → Novelty → Significance) in code + a constrained model pass, not in freehand chat.
- Return at most a handful of ranked suggestions across three tiers (Swap candidate, Update flag, Can't-ignore), each with outlet sourcing and a confidence label.
- Guarantee the script is never mutated on the scan turn; acting on a suggestion is a separate, explicit follow-up.
- Reuse the orchestrator discovery stack and approved-source registry; add no new outlet infrastructure.

## 3. Tasks

### T-001: Script coverage profile — parse an uploaded finalized script
**Description:** Given the finalized script text (uploaded as a text file — already inlined as `<uploaded_file>` by `normalizeMessages`, or pasted), build a machine-readable "coverage profile": the ordered blocks (A/B/C/D), a short topic/event descriptor per block, and the already-cited sources. Reuse `extractSources()` from `app/api/news/route.ts` (extract it into `lib/news-script.ts` so both the route and the scan can call it) for the `SOURCES:` list. Add block detection for the `[A BLOCK]` / `HOST:` structure documented in `lib/news-prompt.ts`.

**Acceptance Criteria:**
- [ ] `lib/news-script.ts` exports `extractSources()` (moved from the route; route re-imports it, behavior unchanged) and a new `parseScriptCoverage(text): { blocks: Array<{ label: string; text: string }>; sources: ExtractedSources }`.
- [ ] Blocks are split on `[X BLOCK]` markers; the intro/outro boilerplate is not treated as a block.
- [ ] A script with no `SOURCES:` section still parses blocks and returns `sources: []` (no throw), matching the tolerant behavior of the existing extractor.
- [ ] Unit test with a sample finalized script (A/B/C blocks + SOURCES) asserts block count, labels, and source count.
- [ ] Quality checks pass (typecheck + lint).

### T-002: Lock-time cutoff input
**Description:** Establish the recency cutoff for a scan. Default the cutoff to the script **upload time** (the moment the scan is triggered), and allow the writer to override it with an explicit lock time (e.g. "locked at 4:15pm"). Cutoff is stored on the scan request, not persisted.

**Acceptance Criteria:**
- [ ] Scan request accepts an optional `lockedAt` ISO timestamp; when absent, the server stamps the request time as the cutoff.
- [ ] Cutoff is echoed back in the scan result so the UI can show "scanning for news since 4:15pm".
- [ ] An override earlier than 12h ago or in the future is rejected with a clear message (guards typos like AM/PM slips).
- [ ] Quality checks pass.

### T-003: Post-lock candidate discovery
**Description:** Add `lib/orchestrator/breaking-scan.ts` with `discoverBreakingCandidates({ today, lockedAt })` that reuses `discoverCandidates()` (Tavily beat queries + `discoverXPosts`) and `verifyOrRecover()`/`extractCandidates()` from `source-gathering.ts`, then filters to candidates whose publication timestamp is at/after `lockedAt` where a timestamp is available. Day-granular Tavily freshness (`freshnessDays`) is the coarse filter; the per-article `publicationDate` is the fine filter.

**Acceptance Criteria:**
- [ ] `discoverBreakingCandidates` returns extracted `Article`/`Candidate` objects scoped to approved sources only (via existing approved-hostname checks).
- [ ] Candidates with a `publicationDate` strictly before `lockedAt` are dropped; candidates with a missing/unparseable date are retained but flagged `dateUncertain: true` (deferred to Gate-3 judgment rather than silently dropped).
- [ ] X-post candidates from the curated handles are retained and tagged with their source handle (needed for the single-source provisional rule).
- [ ] Reuses `substitutePaywallMirrors()` so hard-paywalled candidates are swapped for free mirrors, consistent with the orchestrator.
- [ ] Quality checks pass.

### T-004: Gate 0 — hard-exclusion filter
**Description:** In `breaking-scan.ts`, apply the hard-exclusion filter before any significance work. Suppress: opinion/analysis/op-eds, scheduled events proceeding as scheduled, incremental attrition, routine markets/economic data, and recirculated coverage of old events (dedup by *event*, not article date). The exclusion is defined by **occurrence, not information**: a scheduled event that yields only expected content is excluded, but unexpected reversal-grade information the event produces is NOT excluded.

**Acceptance Criteria:**
- [ ] A classifier pass tags each candidate with an `excluded` boolean + `exclusionReason`; excluded candidates never reach later gates.
- [ ] The prompt encodes the "occurrence vs. information" rule with the resignation-in-a-scheduled-speech and expected-verdict examples from the design discussion.
- [ ] Recirculated-old-event detection keys on the underlying event, so a fresh article about an old event is excluded even if its publish date is post-lock.
- [ ] Fixture test: a set of labeled candidates (an op-ed, a routine market move, a scheduled speech that resigns, an old event re-reported) is classified with the expected excluded/kept outcomes.
- [ ] Quality checks pass.

### T-005: Gate 2 — novelty diff against the script coverage profile
**Description:** Compare surviving candidates against the T-001 coverage profile. Classify each as `NEW` (event/topic absent from the script), `UPDATE` (a development to a story already in the script), or `DUPLICATE` (already covered, no material change → dropped). UPDATE only qualifies on **narrative reversal or order-of-magnitude change** — the existing script line is now wrong, misleading, or overtaken — not on any new fact.

**Acceptance Criteria:**
- [ ] Each candidate resolves to exactly one of NEW / UPDATE / DUPLICATE against the coverage profile blocks + sources.
- [ ] UPDATE requires the change to invalidate/overtake the script's existing line; the prompt encodes the ceasefire-collapse (material) vs. next-round-scheduled (immaterial) and toll-40+-with-commander (material) vs. toll-12→14 (immaterial) examples.
- [ ] DUPLICATEs are dropped and never surfaced.
- [ ] For an UPDATE, the result names which block it updates.
- [ ] Fixture test covers one NEW, one UPDATE, one DUPLICATE against a sample script.
- [ ] Quality checks pass.

### T-006: Gate 3 — significance grading + corroboration
**Description:** Grade the significance of NEW/UPDATE candidates. Corroboration counts **distinct origination, not distinct URLs** (N outlets all citing one journalist = one source). A story needs **≥2 independently-reporting tier-1 outlets** to be firmly significant. A single high-trust curated X source (e.g. Segal, Ravid, Kadosh) counts as **provisional** — enough for an Update flag or low-confidence Swap, labeled "unconfirmed, single source," never a Can't-ignore. The model also applies editorial judgment against Ark's beat + the day's context. Tier-1 membership is read from `isInternationalSource`/`newsSources`.

**Acceptance Criteria:**
- [ ] Each surviving candidate gets `{ corroboration: { independentSources: number, primarySource: string }, confidence: 'confirmed' | 'provisional', significance: 'high' | 'medium' | 'low' }`.
- [ ] Multiple candidates attributing to the same underlying source collapse to one `independentSources` count (the prompt instructs identifying the underlying source, not counting bylines).
- [ ] A single-curated-X-source story is marked `confidence: 'provisional'` and is ineligible for the Can't-ignore tier.
- [ ] Beat membership is available to the grader (on-beat vs off-beat), sourced from the existing source registry / beat query themes.
- [ ] Fixture test: a 2-independent-outlet story grades `confirmed`; a 4-outlets-one-journalist story grades `provisional` with `independentSources: 1`.
- [ ] Quality checks pass.

### T-007: Tier routing → Swap / Update / Can't-ignore
**Description:** Route graded candidates to output tiers. **Swap candidate:** NEW + on-beat + significant; framed relative to the likely-weakest block (C by design) without a numeric lineup comparison. **Update flag:** material UPDATE to an in-script story. **Can't-ignore:** global-shock only (head-of-state death, mass-casualty terror/disaster, war between major powers, US election/constitutional shock) — the only tier allowed off-beat, and it requires `confidence: 'confirmed'`.

**Acceptance Criteria:**
- [ ] Every surfaced suggestion carries `tier`, `headline`, `whyItQualifies`, `sources[]`, `confidence`, and (for Swap) the named weakest block, (for Update) the named block it updates.
- [ ] Can't-ignore only fires for the enumerated global-shock categories AND `confidence: 'confirmed'`; off-beat stories cannot reach Swap/Update.
- [ ] Provisional (single-source) items may appear as Swap/Update but are visibly labeled unconfirmed.
- [ ] Results are ranked (Can't-ignore > Update > Swap, then by significance/confidence) and capped at a small number (default 5) with a note if more were suppressed.
- [ ] A quiet scan returns an explicit empty result: "No breaking news clears the bar since [cutoff]."
- [ ] Quality checks pass.

### T-008: Scan tool + Phase-1 hard-gate routing in news chat
**Description:** Expose the scan from the news chat mode and enforce the Phase-1 hard gate. Implement `scanBreakingNews` as a server tool registered in `app/api/news/route.ts` (alongside `fetchArticle`/`searchCorpus`/`webSearch`) that runs the deterministic T-003→T-007 pipeline and returns structured suggestions; the chat model relays them but performs no editing. Classification uses `generateObject` with Zod schemas so gates are enforced against a schema, not prose. Add a Phase-1 routing section to the news system prompt.

**Acceptance Criteria:**
- [ ] `scanBreakingNews` tool accepts `{ script: string, lockedAt?: string }`, runs discovery + all gates, and returns the tiered suggestion object from T-007.
- [ ] The news system prompt (`lib/news-prompt.ts`) gains a **Phase-1 hard-gate** section: when a finalized script is present and the writer asks to check for breaking news or more relevant stories, the model MUST call `scanBreakingNews` first and MUST NOT edit or draft the script on that turn; it presents results as suggestions only and waits.
- [ ] The prompt distinguishes this scan intent from the existing first-turn "gather + confirm understanding" flow, so uploading a finalized script for a scan does not trigger the drafting path.
- [ ] Tool result is emitted as a typed UI data part so the client can render suggestion cards (see T-009), consistent with the existing `data-sources` pattern.
- [ ] `maxDuration`/Node runtime unchanged; scan completes within the 300s budget for a normal candidate pool.
- [ ] Quality checks pass.

### T-009: Phase-2 — accept a replacement → understanding gate → integrate
**Description:** Wire the second phase. When the writer accepts a specific suggestion, the model enters the **existing** 5-dimension understanding gate (`076ae6d`, defined in `lib/news-prompt.ts` "First Turn: Gather, Then Confirm Understanding") **scoped to that one story**: fetch its full sources via `fetchArticle`, read back the five-dimension understanding, and wait. Only after the writer confirms does the model write the replacement into the script. This is understanding-readback only — no re-verification of corroboration (already done in the scan).

**Acceptance Criteria:**
- [ ] The news system prompt gains a **Phase-2** section: on writer acceptance of a suggestion, run the understanding gate for that story only, then (after confirmation) write the replacement into the script — replacing the displaced block for a Swap, or revising the affected block for an Update.
- [ ] The gate reuses the existing five-dimension readback (what happened / why it matters / key players / sourcing / timeline); it does not re-run corroboration or significance.
- [ ] Accepting one suggestion runs a gate for that story only and does not integrate other pending suggestions.
- [ ] After confirmation, the model outputs the revised script (or revised block) directly, with no preamble, per existing style rules; the `SOURCES:` list is updated to include the new story's sources.
- [ ] Multiple sequential accepts each run their own gate and compound onto the working script.
- [ ] Quality checks pass.

### T-010: Suggestion cards + accept affordance in the news UI
**Description:** Render Phase-1 scan results in `app/(chat)/news/[id]/page.tsx` as suggestion cards grouped by tier, each showing the tier badge, headline, why-it-qualifies, sources (linked), confidence label, and — for Swap/Update — the referenced block. Include the "scanning since [cutoff]" header and the explicit empty state. Each card has an **Accept** affordance that sends the Phase-2 acceptance message for that story. Provide the initial affordance to upload/paste the finalized script and trigger a scan.

**Acceptance Criteria:**
- [ ] A "Scan for breaking news" affordance is available after a finalized script is provided in news chat.
- [ ] Suggestion cards render grouped by tier with badges (Can't-ignore / Update / Swap), sources as links, and a visible confidence label; provisional items are clearly marked unconfirmed.
- [ ] Each card has an Accept action that triggers the Phase-2 flow for that specific story (understanding gate), and does not itself edit the script.
- [ ] Empty state renders the "nothing clears the bar since [cutoff]" message.
- [ ] Conditional rendering uses ternaries, not `&&`, per project convention.
- [ ] No script text is edited during Phase 1; the script only changes after a Phase-2 confirmation.
- [ ] Verify in browser (dev server): upload a sample script, run a scan, confirm cards render and the script is untouched until a suggestion is accepted and confirmed.
- [ ] Quality checks pass.

## 4. Functional Requirements

- **FR-1:** The system must accept a finalized script (uploaded text file or pasted) in the news chat mode and parse it into blocks + cited sources.
- **FR-2:** The system must take a recency cutoff defaulting to script upload time, overridable by an explicit lock time; overrides outside a sane window (future, or >12h ago) must be rejected.
- **FR-3:** The system must discover candidate stories only from the approved sources in `lib/news-sources.ts`, reusing the orchestrator discovery stack, and drop candidates published before the cutoff (retaining, but flagging, undated ones).
- **FR-4 (Gate 0):** The system must hard-suppress opinion/analysis, scheduled-as-planned occurrences, incremental attrition, routine market data, and recirculated old events — where "scheduled-as-planned" excludes the *occurrence* but never *reversal-grade new information* the event produces.
- **FR-5 (Gate 2):** The system must classify each surviving candidate as NEW, UPDATE, or DUPLICATE against the script coverage profile; DUPLICATEs are dropped; UPDATE requires narrative-reversal or order-of-magnitude change.
- **FR-6 (Gate 3):** The system must grade significance with corroboration counted by distinct origination (≥2 independent tier-1 outlets = confirmed); a single curated high-trust X source is provisional and ineligible for Can't-ignore.
- **FR-7:** The system must route qualifying candidates to exactly one tier — Swap candidate (NEW, on-beat), Update flag (material UPDATE), or Can't-ignore (confirmed global-shock, the only off-beat-eligible tier).
- **FR-8:** The system must return a ranked, capped list of suggestions, each with headline, why-it-qualifies, linked sources, confidence label, and the referenced block where applicable; and an explicit empty result when nothing qualifies.
- **FR-9 (Phase-1 hard gate):** When a finalized script is present and the writer asks to check for breaking news / more relevant stories, the system must enter the scan flow first (`scanBreakingNews`) and must NOT edit, rewrite, draft, or auto-swap the script on that turn, nor run the understanding gate.
- **FR-10 (Phase-2 per-story gate):** Only after the writer accepts a specific replacement must the system enter the existing 5-dimension understanding gate for that one story; and only after the writer confirms understanding may it write that replacement into the script.
- **FR-11:** The Phase-2 gate must be understanding-readback only (reusing `076ae6d`) and must not re-run corroboration/significance, which were established in the scan. Each accepted replacement runs its own independent gate.

## 5. Non-Goals (Out of Scope)

- No continuous/timer-based monitoring — v1 is on-demand per scan (a scheduled auto-scan is a future extension).
- No automatic script editing, story swapping, or re-drafting on the scan turn (Phase 1). Integration happens only after a Phase-2 confirmation.
- No new confirmation mechanism — Phase 2 reuses the existing `076ae6d` understanding gate rather than inventing a parallel one.
- No batch-accept — the writer accepts replacements one at a time, each running its own gate.
- No new outlets or discovery infrastructure beyond `lib/news-sources.ts` and the existing orchestrator stack.
- No numeric re-scoring of the already-finalized lineup.
- No persistence of scan results beyond the chat turn (no new DB tables in v1).
- No non-English-market expansion beyond what the current source set + translation already cover.

## 6. Technical Considerations

- **Integration points:** `app/api/news/route.ts` (tool registration, `extractSources`), `lib/orchestrator/source-gathering.ts` (`discoverCandidates`, `discoverXPosts`, `verifyOrRecover`, `extractCandidates`, `inAcceptableRange`, `substitutePaywallMirrors`, `freshnessDays`), `lib/news-sources.ts` (approved/tier/paywall checks), `lib/news-prompt.ts` (system prompt), `app/(chat)/news/[id]/page.tsx` (UI).
- **Recency granularity:** Tavily freshness is day-granular; per-article `publicationDate` gives finer resolution but is sometimes missing. The design intentionally retains undated candidates and defers them to Gate-3 judgment rather than dropping them.
- **Classification reliability:** gates run as structured `generateObject` passes with Zod schemas so outputs conform to the tier model, rather than being parsed from prose.
- **Latency:** discovery + multi-gate classification must fit the existing 300s `maxDuration`; keep the candidate pool bounded (reuse the orchestrator's cap of ~20 active candidates).
- **Cost/altitude:** classification is the expensive part; batch candidates through gates rather than one model call per candidate where feasible.

## 7. Success Metrics

- Precision over recall: in writer review, surfaced suggestions are judged "worth interrupting for" the large majority of the time (few false alarms).
- Zero already-covered (DUPLICATE) or hard-excluded items appear in results.
- Quiet windows return the explicit empty state rather than manufactured flags.
- The finalized script is byte-for-byte unchanged after a scan.
- A scan completes well within the 300s budget on a normal window.

## 8. Open Questions

- **Single-source X provisional threshold:** confirmed in design that one curated X source yields a provisional flag. Do we want a per-handle trust tier (some handles stronger than others), or treat all curated handles as equal-trust for v1? (Assumed equal-trust for v1.)
- **Swap "weakest block" heuristic:** v1 assumes the C block is weakest by design. Should the writer be able to tell the scan which block they consider most droppable? (Deferred; C-block default for v1.)
- **Future auto-scan:** should a later version poll on an interval through the 4–6pm window and push notifications, rather than on-demand? (Out of scope for v1; noted for roadmap.)
- **Corroboration source-graph:** identifying "distinct origination" reliably may need the model to reason about attribution chains; if accuracy is weak in testing, do we fall back to a simpler distinct-outlet count with a disclaimer?
