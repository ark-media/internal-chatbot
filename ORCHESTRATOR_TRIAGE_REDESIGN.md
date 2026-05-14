# Orchestrator Redesign: Article Triage → On-Demand Grouping

**Status**: Implemented (slices 1–5) — 2026-05-14
**Last Updated**: 2026-05-14
**Related**: `ORCHESTRATOR_SPEC.md` (the current formal spec)

> **Implementation note.** Built in the five slices below. Three §10 questions
> were confirmed before slice 1: (1) "replace checkpoint" = keep `CheckpointView`
> as step 2 (the §2 assumption); (2) **`urls` mode skips triage** — diverges from
> §3/§5 below, which originally routed `urls` through triage; (3) triage removal
> is permanent. Slice 5 kept `CheckpointView` per-topic attach/refetch intact —
> the §8 two-surface overlap stays a documented v1 tradeoff.

---

## 1. Motivation

Today the orchestrator's `discover` flow is **AI-first**: `gather → distill` runs immediately,
so the first thing the writer sees is a set of AI-chosen topics to approve or reject. The writer
never works with the raw article list — they can only edit the AI's grouping after the fact.

This redesign makes the flow **article-first**:

1. The writer sees the raw gathered articles in a **draggable list** and triages them — rank
   (working order), prune what they don't want.
2. **Keyword search** is available as an escape hatch when the automatic pull is weak.
3. Grouping into topics becomes a **deliberate, on-demand step** the writer triggers when ready.

## 2. Decisions

These were settled before planning; they shape the rest of the doc.

| Question | Decision |
|---|---|
| How much does the AI do in the grouping step? | **AI groups on demand** — writer ranks/prunes first, then clicks to group the survivors. |
| What does article ranking drive downstream? | **Triage only** — rank is the writer's working order; nothing downstream reads it. |
| What kind of "search to add articles"? | **Keyword search (new)** — a query box backed by Tavily, scoped to approved outlets. |
| Relationship to the existing checkpoint stage? | **Replace checkpoint** — see the assumption below. |

### Working assumption on "replace checkpoint"

"Replace checkpoint" is read as: **insert a `triage` stage and make grouping on-demand; the
topic-review surface still exists but becomes step 2**, fed by grouping, rather than being the
first thing the writer sees. The existing `CheckpointView` UI is largely reused — it is no longer
the entry experience, but the writer still needs a surface to review grouped topics and trigger
generation.

If the intent was to remove the topic-review screen entirely, this plan changes materially —
flag it before slice 1.

## 3. Flow

### Current

```
discover → gathering → [distill] → checkpoint → [generate] → crafting → complete
urls     → gathering → [distill] → checkpoint → ...
topics   → gathering → checkpoint → ...
```

### New

```
discover → gathering → triage → [group] → checkpoint → [generate] → crafting → complete
urls     → gathering → [distill] → checkpoint → ...    (skips triage — writer hand-picked URLs)
topics   → gathering → checkpoint → ...                (skips triage — born grouped)
```

- **`triage`** (new stage): a flat, draggable list of `run.articles`. The writer reorders (rank),
  removes articles, and runs keyword searches to add more. One sticky action:
  **"Group into topics (N)"**.
- **`[group]`** (new action): the AI grouping pass — this is today's `distillTopics()`
  (group + score + summarize + extract quotes), simply called *here*, on the survivors, instead
  of inside `/start`. This resolves the enrichment-timing question: summaries and key quotes are
  generated only for articles that survived triage, not for everything gathered.
- **`checkpoint`**: essentially today's `CheckpointView`, now reached *after* grouping. Adds a
  "← Re-group" path back to `triage` (clears `distill`, stage → `triage`).
- **`urls` and `topics` start modes** skip triage. `topics` is born grouped; `urls` keeps today's
  behavior (`/start` extracts and calls `distillTopics()` directly) since the writer hand-picked
  those URLs. Both go straight to `checkpoint`. Only `discover` routes through `triage`.

## 4. Data model

Files: `lib/orchestrator/types.ts`, `lib/orchestrator/state.ts`

- Add `'triage'` to the `OrchestratorStage` union:
  `gathering | triage | checkpoint | crafting | complete | error`.
- `run.articles` **is** the triage list — it is already a flat, URL-deduped array. Reordering and
  removing simply mutate this array.
- **Rank order persists across reloads** (it is just the array order — free) but **nothing
  downstream reads order** — `/generate` and `craftScript` ignore it. This is the "triage only"
  contract.
- `run.distill` stays `null` until `[group]` runs. Today it is populated immediately after gather.
- **No DB migration.** Runs are a single JSONB blob in `orchestrator_runs.state`. Old-shape runs
  (no `triage` stage) keep working and age out naturally via the 7-day `expires_at`.

## 5. API routes

Directory: `app/api/news/orchestrator/`

| Route | Change |
|---|---|
| `POST /start` | `discover` mode stops at `triage` — does **not** call `distillTopics()`. `urls` and `topics` modes unchanged (still land at `checkpoint`). |
| `POST /group` | **New.** `mode: 'group'` runs `distillTopics()` on `run.articles` and advances `triage → checkpoint` (CAS on stage). `mode: 'regroup'` clears `distill` and goes `checkpoint → triage`. (Distill call lifted out of `/start`.) |
| `POST /triage` | **New.** Actions `reorder` (new URL order), `remove` (url), and `add` (url — extracts a search hit into `run.articles`). Optimistic-locked via `saveRunIfUnchanged`, same pattern as `/topics`. |
| `POST /search` | **New.** Keyword search — see §6. |
| `POST /topics`, `/attach`, `/refetch`, `/generate`, `/refine`, `/edit`, `/undo`, `/save-learn` | Unchanged. `/generate` already CAS-flips from `checkpoint`. |

## 6. Keyword search (the net-new capability)

There is no user-facing search today — discovery is Gemini-driven only.

- **Library wrapper** (`lib/orchestrator/source-gathering.ts`): generalize the existing
  `searchByTitle()` — already a Tavily `/search` call, currently locked to a single domain — into
  a multi-domain keyword query using `include_domains: approvedHostnames`.
- **`/search` route**: takes a query, returns candidate hits (title / url / source) **without
  extraction** — cheap. The writer clicks "Add" on a result; *that* is when we call
  `extractUrlToArticle()` and append to `run.articles`.
- **Limitation:** Tavily domain-scoping cannot target specific X/Twitter *handles*, so keyword
  search effectively covers the news sites and think tanks, not the 15 X accounts. X stays
  Gemini-discovery-only. Surface this in the UI so writers aren't surprised.

## 7. UI

File: `app/(chat)/news/orchestrator/[id]/page.tsx`

- **`TriageView`** (new component for stage `triage`):
  - Sortable list of `run.articles` — drag handle, title, source, date, freshness flag, remove ✕.
  - Keyword-search panel: query input → results list → "Add" per result.
  - Sticky footer: **"Group into topics (N)"** → `POST /group`.
- **`ProgressCard`**: add a "Grouping articles into topics…" state for the `/group` call.
- **`CheckpointView`**: mostly reused. Add a "← Re-group" affordance (clears `distill`,
  stage → `triage`), analogous to today's "Edit topics & regenerate" (`complete → checkpoint`).
- **`StartCard`** / progress copy: `discover` and `urls` completion now lands at `triage`, not
  `checkpoint`.

### New dependency

`@dnd-kit/core` + `@dnd-kit/sortable`. No drag-and-drop library exists in the project today.
dnd-kit is the modern, accessible, touch-friendly choice and tree-shakes small. The alternative —
hand-rolling HTML5 drag events — avoids the dependency but is fiddly and weak on accessibility and
touch. **Recommendation: add dnd-kit.**

## 8. Risks & tradeoffs

- **Two article surfaces.** Triage works at the article level; `CheckpointView` still has
  per-topic attach/refetch. Acceptable for v1, but worth a follow-up pass to decide whether
  per-topic attach is now redundant with global keyword search.
- **Grouping latency is now visible.** The Haiku + Sonnet distill pass runs on an explicit click
  instead of being hidden inside `/start`. Net better UX (clear progress), but it is a real wait
  the writer now sees.
- **Tavily cost.** Searches and per-add extraction are billed API calls. Gate behind an explicit
  "Search" click and "Add" button — no search-as-you-type.
- **Long lists.** If keyword search balloons the pool past ~30 articles, drag-ranking gets
  tedious. Fine at the typical 12–15; revisit if it becomes a problem.
- **Small-N grouping.** If the writer prunes down to 1–2 articles, `distillTopics()` must still
  behave. Verify in slice 1.

## 9. Build order

Thin vertical slices — each one leaves the orchestrator working end-to-end.

1. **Stage + `/group` route.** Add the `triage` stage; lift the distill call out of `/start` into
   a new `/group` route; render a placeholder `TriageView` with a plain (non-draggable) list and a
   "Group" button. Verify `gather → triage → group → checkpoint`. Check small-N grouping.
2. **TriageView with reorder + remove.** Add dnd-kit; build the sortable list and the `/triage`
   route. Verify rank order and removals survive a reload.
3. **Keyword search.** Tavily multi-domain wrapper, `/search` route, search panel UI, "Add" →
   `extractUrlToArticle` → append.
4. **Polish.** Progress states, "← Re-group" navigation, `urls` / `topics` mode routing, copy.
5. **Cleanup.** Decide what (if anything) to trim from `CheckpointView` now that triage exists.

## 10. Open questions — resolved

- ~~Confirm the §2 assumption on "replace checkpoint" before starting slice 1.~~ **Confirmed:**
  `CheckpointView` stays as step 2, reached after grouping; a "← Re-group articles" affordance
  returns to `triage`.
- ~~Should `urls` mode really pass through `triage`?~~ **No** — `urls` skips triage and keeps its
  current `gather → distill → checkpoint` flow (see §3/§5). Only `discover` routes through triage.
- ~~Undo for triage removals?~~ **Permanent for v1** — `remove` deletes from `run.articles` with
  no stash. Revisit if writers ask.
